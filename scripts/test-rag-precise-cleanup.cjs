'use strict';
// Run production policy and native RAG IPC against an isolated SQLite substitute.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
let harness=fs.readFileSync(path.join(__dirname,'test-rag-restore-fence.cjs'),'utf8');
harness=harness.slice(0,harness.lastIndexOf('(async () => {'));
harness+=`
(async()=>{
  const policyBox={exports:{}};
  const policyCode=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../services/memoryCorrectionPolicy.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(policyCode,{module:policyBox,exports:policyBox.exports,Set,Object,Array,Number,String});
  const policy=policyBox.exports;
  const provenance=new Map([
    ['derived',{sourceRefs:[{kind:'message',id:'target',version:'v1'}]}],
    ['safe',{sourceRefs:[{kind:'message',id:'other',version:'v1'}]}]
  ]);
  const h=load({provenance});
  for(const row of [
    {id:'direct',text:'target',messageId:'target',source:'rebuild_message',timestamp:10},
    {id:'derived',text:'derived target',source:'memory_chunk',timestamp:10},
    {id:'safe',text:'other memory',source:'memory_chunk',timestamp:10},
    {id:'legacy',text:'unknown old',source:'memory_chunk',timestamp:10},
    {id:'future',text:'unknown new',source:'memory_chunk',timestamp:200},
    {id:'lore',text:'official lore',source:'official_lore',tier:'lore',timestamp:10},
  ]) assert.equal((await h.invoke('rag:save',row)).success,true);
  const rule={messageIds:['target'],artifactIds:[],includeLegacyDerived:true,legacyCutoff:100,createdAt:100};
  assert.equal((await h.invoke('rag:restore-lock',{id:'correction',action:'begin',kind:'memory'})).success,true);
  assert.equal((await h.invoke('rag:get-all',{restoreSessionId:'correction'},h.stranger)).success,false);
  const snapshot=await h.invoke('rag:get-all',{restoreSessionId:'correction'});
  const retained=snapshot.vectors.filter(row=>!policy.ruleMatchesRow(row,'vectors',rule));
  assert.equal((await h.invoke('rag:restore',{vectors:retained,restoreSessionId:'correction',purpose:'memory-maintenance'})).success,true);
  const actual=(await h.invoke('rag:get-all',{restoreSessionId:'correction'})).vectors.map(row=>row.id).sort();
  assert.deepEqual(actual,['future','lore','safe'],'only targeted or approved unproven vectors removed');
  assert.equal((await h.invoke('rag:restore-lock',{id:'correction',action:'end',kind:'memory',committed:true})).success,true);
  assert.equal((await h.invoke('rag:save',{id:'late',text:'target',dataMemoryGeneration:'old'})).success,false);
  console.log('Native RAG precise cleanup passed: targeted, sourced derivative, approved legacy, preserved lore/unrelated and stale writer.');
})().catch(error=>{console.error(error);process.exitCode=1;});`;
vm.runInThisContext(`(function(require,__dirname){${harness}\n})`,{filename:__filename})(require,__dirname);
