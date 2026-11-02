'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createCredentialVault} = require('../electron/credential-vault.cjs');
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kumiko-vault-test-'));
  let enabled = true, bad = false, request;
  const safeStorage = {isEncryptionAvailable: () => enabled, encryptString: s => Buffer.from('fixture:' + Buffer.from(s).toString('base64')), decryptString: b => {
    if (bad) throw Error('fixture failure'); const text = b.toString(); if (!text.startsWith('fixture:')) throw Error(); return Buffer.from(text.slice(8), 'base64').toString();
  }};
  const vault = createCredentialVault({directory, safeStorage, fetchImpl: async (url, options) => {request = {url, options}; return url.includes('generateContent')
    ? new Response(JSON.stringify({candidates:[{content:{parts:[{text:'fixture response'}],role:'model'},finishReason:'STOP'}]}), {status:200,headers:{'content-type':'application/json'}})
    : new Response('ok', {status:200});}});
  try {
    assert.equal(await vault.getInternalBackupKey(), null);
    await vault.setInternalBackupKey('backup-fixture-secret');
    assert.equal(await vault.getInternalBackupKey(), 'backup-fixture-secret');
    bad = true; await assert.rejects(vault.setInternalBackupKey('replacement')); bad = false;
    assert.equal(await vault.getInternalBackupKey(), 'backup-fixture-secret');
    enabled = false; await assert.rejects(vault.setInternalBackupKey('replacement'), /unavailable/); enabled = true;
    const credential = await vault.storeCredential({purpose:'openai', endpoint:'https://example.test/v1/chat/completions', secret:'synthetic-key'});
    assert.ok(!JSON.stringify(credential).includes('synthetic-key'));
    await assert.rejects(vault.request({handle:credential.handle,purpose:'gemini',body:'{}'}), /binding/);
    await assert.rejects(vault.request({handle:credential.handle,purpose:'openai',body:'{}',expectedEndpoint:'https://attacker.test/'}), /binding/);
    await assert.rejects(vault.storeCredential({purpose:'openai',endpoint:'https://user:pass@example.test/',secret:'s'}));
    await assert.rejects(vault.storeCredential({purpose:'openai',endpoint:'http://example.test/',secret:'s'}));
    await assert.rejects(vault.storeCredential({purpose:'openai',endpoint:'https://example.test/?key=s',secret:'s'}));
    const result = await vault.request({handle:credential.handle,purpose:'openai',body:'{}',endpoint:'https://attacker.test/'});
    assert.equal(result.status,200); assert.equal(request.url,'https://example.test/v1/chat/completions');
    assert.equal(request.options.redirect,'error'); assert.equal(request.options.headers.authorization,'Bearer synthetic-key');
    assert.equal(Buffer.from(result.body,'base64').toString(),'ok');
    const gemini = await vault.storeCredential({purpose:'gemini',endpoint:'https://example.test/',secret:'gemini-synthetic'});
    const generated = await vault.generateGemini({handle:gemini.handle,params:{model:'fixture',contents:'hello'}});
    assert.equal(generated.text,'fixture response'); assert.equal(request.options.redirect,'error');
    assert.equal(request.url,'https://example.test/v1beta/models/fixture:generateContent');
    assert.equal(new Headers(request.options.headers).get('x-goog-api-key'),'gemini-synthetic');
    await assert.rejects(vault.generateGemini({handle:gemini.handle,params:{model:'fixture',contents:'hello',config:{httpOptions:{baseUrl:'https://attacker.test'}}}}));
    const search = await vault.storeCredential({purpose:'tavily',endpoint:'https://search.omkk.org/',secret:'tavily-synthetic'});
    assert.equal((await vault.tavily({handle:search.handle,operation:'search',query:'fixture'})).status,200);
    assert.equal(request.url,'https://search.omkk.org/api/search?q=fixture'); assert.equal(request.options.redirect,'error');
    assert.equal(request.options.headers['x-api-key'],'tavily-synthetic');
    assert.equal((await vault.tavily({handle:search.handle,operation:'usage'})).status,200);
    assert.equal(request.url,'https://search.omkk.org/api/usage');
    await assert.rejects(vault.tavily({handle:search.handle,operation:'https://attacker.test/'}));
    const controller = new AbortController(); let networkSignal;
    const delayedVault = createCredentialVault({directory, safeStorage, fetchImpl: async (_url, options) => {
      networkSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), {once:true}));
    }});
    const pending = delayedVault.request({handle:credential.handle,purpose:'openai',body:'{}',signal:controller.signal});
    while (!networkSignal) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await assert.rejects(pending); assert.equal(networkSignal.aborted,true);
    await fs.writeFile(path.join(directory,'unrelated.txt'),'keep');
    await vault.clearCredentials(); await vault.clearCredentials();
    assert.equal(await vault.getInternalBackupKey(), 'backup-fixture-secret');
    await assert.rejects(vault.generateGemini({handle:gemini.handle,params:{model:'fixture',contents:'hello'}}),/binding/);
    assert.equal(await fs.readFile(path.join(directory,'unrelated.txt'),'utf8'),'keep');
    await vault.clearAll(); await vault.clearAll(); assert.equal(await vault.getInternalBackupKey(),null);
    console.log('Credential vault fixture checks passed: verified writes, failure preservation, unavailable storage, binding and redirect refusal.');
  } finally {await fs.rm(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
