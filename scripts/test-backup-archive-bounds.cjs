'use strict';
const assert = require('node:assert/strict');
const JSZip = require('jszip');

(async () => {
  const { createBackupArchiveReader } = await import('../services/backupArchiveValidation.mjs');
  const fixture = new JSZip();
  const text = '久美子 🎶\n'.repeat(9000);
  const binary = Buffer.alloc(65539);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
  fixture.file('data.json', new TextEncoder().encode(text)).file('images/test.bin', binary);
  const loaded = await JSZip.loadAsync(await fixture.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const reader = createBackupArchiveReader(loaded);
  assert.equal(await reader.read(loaded.file('data.json')), text);
  assert.equal(await reader.read(loaded.file('images/test.bin'), 'base64'), binary.toString('base64'));

  // Forge the size in both on-disk ZIP headers. Declared-size validation passes,
  // but real inflation must stop at the small test bound, before accumulation.
  const bomb = new JSZip().file('data.json', 'a'.repeat(256 * 1024));
  const forged = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const central = forged.indexOf(Buffer.from('504b0102', 'hex'));
  assert.ok(central > 0);
  forged.writeUInt32LE(1, 22);
  forged.writeUInt32LE(1, central + 24);
  const poisoned = await JSZip.loadAsync(forged);
  const limited = createBackupArchiveReader(poisoned, { entryLimit: 16384 });
  await assert.rejects(limited.read(poisoned.file('data.json')), /read limit/);
  await assert.rejects(limited.read(poisoned.file('data.json')), /read limit/, 'failed archive cannot resume');

  const pair = new JSZip().file('one', 'a'.repeat(32768)).file('two', 'b'.repeat(32768));
  const pairLoaded = await JSZip.loadAsync(await pair.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const cumulative = createBackupArchiveReader(pairLoaded, { entryLimit: 40000, totalLimit: 49152 });
  const outcomes = await Promise.allSettled([cumulative.read(pairLoaded.file('one')), cumulative.read(pairLoaded.file('two'))]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.match(outcomes[1].reason.message, /read limit/);

  // Old unencrypted ZIPs still get CRC integrity checks, after bounded reading.
  const stored = await new JSZip().file('data.json', 'fixture-value').generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  stored[30 + stored.readUInt16LE(26) + stored.readUInt16LE(28)] ^= 1;
  const corrupted = await JSZip.loadAsync(stored);
  await assert.rejects(createBackupArchiveReader(corrupted).read(corrupted.file('data.json')), /integrity/);
  assert.throws(() => createBackupArchiveReader(loaded, { totalLimit: 1024 * 1024 * 1024 }), /limit/);
  console.log('Backup archive bounds passed: forged sizes, actual entry/total limits, CRC, Unicode and binary round trips.');
})().catch(error => { console.error(error); process.exitCode = 1; });
