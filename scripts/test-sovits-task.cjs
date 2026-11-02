'use strict';
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const source=ts.transpileModule(fs.readFileSync('services/genieAudioService.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let target, signalSeen, checked=0;
const gateway={ runTaskTransport:async(ctx,t,work,check)=>{target=t;check();return work(ctx.signal);}, runStandaloneTransport:async(t,work,check,signal)=>{target=t;check();return work(signal);} };
const m={exports:{}};vm.runInNewContext(source,{module:m,exports:m.exports,AbortSignal,Math,fetch:async(_url,opts)=>{signalSeen=opts.signal;return {ok:true,arrayBuffer:async()=>new ArrayBuffer(128)}} ,require:id=>id==='./taskGateway'?gateway:id==='../constants'?{EMOTION_TO_SOVITS_REF:{neutral:[{file:'fixture',promptText:'fixture'}]}}:{}});
(async()=>{const signal=new AbortController().signal;const result=await m.exports.genieTtsWithEmotion('fixture','neutral',{sovitsPort:9880},undefined,signal,{signal},()=>{checked++});assert.equal(result.audio.byteLength,128);assert.equal(target.remote,false);assert.ok(signalSeen);assert.equal(checked,1);console.log('SoVITS task fixture passed: local request shares context, cancellation and config check without remote quota.');})().catch(e=>{console.error(e);process.exitCode=1});
