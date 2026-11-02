'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../preload.cjs'),'utf8'), exposed={},calls=[];
const electron={contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},ipcRenderer:{invoke:async(channel,data)=>{calls.push({channel,data});return {};},send(){},on(){},removeListener(){}}};
const storage={getItem:key=>key==='kumiko_memory_generation_v1'?'memory-a':key==='kumiko_media_reset_generation_v1'?'reset-a':null};
vm.runInNewContext(source,{require:id=>{assert.equal(id,'electron');return electron;},process:{platform:'win32'},localStorage:storage,console});
(async()=>{
  await exposed.electronAPI.invoke('rag:embed','fixture text');
  assert.equal(calls.at(-1).data.text,'fixture text');assert.equal(calls.at(-1).data.dataMemoryGeneration,'memory-a');
  await exposed.electronAPI.invoke('rag:restore',[{id:'fixture'}]);
  assert.equal(calls.at(-1).data.vectors[0].id,'fixture');assert.equal(calls.at(-1).data.dataResetGeneration,'reset-a');
  await exposed.electronAPI.invoke('rag:save',{id:'x',text:'fixture'});
  assert.equal(calls.at(-1).data.dataMemoryGeneration,'memory-a');
  await exposed.electronAPI.invoke('rag:restore-lock',{id:'lock',action:'begin'});
  assert.equal(calls.at(-1).data.dataMemoryGeneration,undefined,'lock protocol keeps its owner payload');
  console.log('Preload memory fence passed: old-window generations accompany RAG writes and compatible payloads.');
})().catch(error=>{console.error(error);process.exitCode=1;});
