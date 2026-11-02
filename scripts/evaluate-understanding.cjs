#!/usr/bin/env node
'use strict';
// Deliberately opt-in. Uses synthetic fixtures, never app credentials/history,
// never writes reminders/location. Production prompt/parser are executed as-is.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const live = args.includes('--live');
const suite = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/understanding-evaluation.json'), 'utf8'));
assert.equal(suite.version, 1);
assert.equal(new Set(suite.cases.map(c => c.id)).size, suite.cases.length);
for (const c of suite.cases) assert.ok(typeof c.text === 'string' && Array.isArray(c.reminders) && Array.isArray(c.locations));
if (!live) {
  console.log(JSON.stringify({mode:'dry-run',cases:suite.cases.length,networkCalls:0,
    scope:suite.scope, liveRequires:['--endpoint','--model','--max-calls','--max-usd','--input-usd-per-million','--output-usd-per-million','KUMIKO_EVAL_API_KEY environment variable'],
    note:'No quality score: real provider has not been evaluated. Prices must be verified for the selected provider/model.'}, null, 2));
  process.exit(0);
}
const endpoint = new URL(option('--endpoint') || '');
assert.ok(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Use a credential-free HTTPS chat-completions endpoint');
const model = option('--model'); assert.ok(model && model.length < 200, 'Model required');
const apiKey = process.env.KUMIKO_EVAL_API_KEY; assert.ok(apiKey, 'Dedicated evaluation key required; app storage is never read');
const maxCalls = Number(option('--max-calls'));
const maxUsd = Number(option('--max-usd'));
const inPrice = Number(option('--input-usd-per-million'));
const outPrice = Number(option('--output-usd-per-million'));
assert.ok(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 40, 'Set call budget 1-40');
assert.ok(Number.isFinite(maxUsd) && maxUsd > 0 && maxUsd <= 100, 'Set explicit USD budget');
assert.ok(Number.isFinite(inPrice) && inPrice > 0 && Number.isFinite(outPrice) && outPrice > 0, 'Verified token prices required');
const maxOutput = 1200;
let calls=0, reservedUsd=0, lastUsage=null, lastFailure=null;
function load(file, dependencies) {
  const module={exports:{}};
  const output=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:file}).outputText;
  vm.runInNewContext(output,{module,exports:module.exports,Date,Intl,URL,AbortController,setTimeout,clearTimeout,
    console:{log(){},warn(){},error(){}},require(id){assert.ok(Object.hasOwn(dependencies,id),`Unexpected dependency ${id}`);return dependencies[id];},
    fetch(){throw Error('Location/weather network is forbidden in understanding evaluation');}}, {filename:file});
  return module.exports;
}
const location=load('services/userKnownLocation.ts',{'./db':{db:{}}});
const router=load('services/taskModelRouter.ts',{'./appConfig':{getDefaultMainModel:()=>model}});
const understanding=load('services/turnUnderstanding.ts',{'./userKnownLocation':location,'./taskModelRouter':router,'./llmCore':{
  getCurrentAIConfig:()=>({model_main:model}),
  async callLLMRaw(system,user){
    // UTF-8 bytes is a conservative text-token reservation, not a measured
    // tokenizer count. Provider-specific hidden/reasoning fees are excluded;
    // only use models whose documented output cap covers billable output.
    const reserve=((Buffer.byteLength(system+user,'utf8')+512)*inPrice+maxOutput*outPrice)/1e6;
    if(calls>=maxCalls || reservedUsd+reserve>maxUsd){lastFailure='budget';throw Error('Evaluation budget reached');}
    calls++;reservedUsd+=reserve;
    const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45_000),
      headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model,messages:[{role:'system',content:system},{role:'user',content:user}],temperature:0,max_tokens:maxOutput})});
    if(!response.ok){lastFailure=`HTTP ${response.status}`;throw Error(lastFailure);}
    const payload=await response.json();
    lastUsage=payload.usage ? {prompt_tokens:payload.usage.prompt_tokens,completion_tokens:payload.usage.completion_tokens} : null;
    const content=payload.choices?.[0]?.message?.content;
    if(typeof content!=='string'){lastFailure='Invalid provider response';throw Error(lastFailure);}
    return content;
  }
}});
(async()=>{
  const results=[];
  for(const sample of suite.cases){
    if(calls>=maxCalls)break;
    const started=performance.now();lastFailure=null;lastUsage=null;
    const result=await understanding.understandUserTurn({sources:[{id:sample.id,role:'user',text:sample.text,timestamp:1793516400000}],reminders:sample.existing||[],language:'zh'});
    if(lastFailure==='budget')break;
    const rem=Array.from(result.reminders,c=>c.kind).sort();
    const loc=Array.from(result.locations,c=>c.fact.kind).sort();
    const expectedRem=[...sample.reminders].sort(),expectedLoc=[...sample.locations].sort();
    const exact=JSON.stringify(rem)===JSON.stringify(expectedRem)&&JSON.stringify(loc)===JSON.stringify(expectedLoc);
    const passed=result.status==='understood'&&(exact||(sample.incomplete&&result.clarification&&rem.length===0))&&(!sample.clarification||!!result.clarification);
    results.push({id:sample.id,passed:!!passed,status:result.status,reminders:rem,locations:loc,clarified:!!result.clarification,
      falsePositive:(expectedRem.length===0&&rem.length>0)||(expectedLoc.length===0&&loc.length>0),
      elapsedMs:Math.round(performance.now()-started),usage:lastUsage,error:lastFailure});
    console.log(JSON.stringify(results.at(-1)));
    if(lastFailure)break; // No retry storm on quota/auth/provider failures.
  }
  const report={version:1,createdAt:new Date().toISOString(),model,endpointOrigin:endpoint.origin,
    scope:suite.scope,complete:results.length===suite.cases.length,calls,maxCalls,maxUsd,reservedUsd,
    prices:{inputUsdPerMillion:inPrice,outputUsdPerMillion:outPrice},
    passed:results.filter(r=>r.passed).length,falsePositives:results.filter(r=>r.falsePositive).length,
    unavailable:results.filter(r=>r.status!=='understood').length,results,
    limits:['Measures understanding plus source gates only; not action execution, dialogue quality, weather, or device delivery.',
      'Published regression set; not a blinded holdout. Prices and billing behavior must be verified before live use.']};
  const directory=path.join(root,'artifacts','evaluations');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`understanding-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:file,complete:report.complete,passed:report.passed,falsePositives:report.falsePositives,calls,reservedUsd}));
  if(!report.complete||report.passed!==results.length)process.exitCode=1;
})().catch(()=>{console.error('Evaluation stopped; credentials and provider response bodies are not logged.');process.exitCode=1;});
