#!/usr/bin/env node
'use strict';

// Production known-location service and tool executor with disposable in-memory
// storage and public-API fixtures. No live conversations, IP lookup or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const now = Date.parse('2026-11-01T16:05:00Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const silent = { log() {}, warn() {}, error() {} };
const store = new Map();
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
let transactionQueue = Promise.resolve();
const db = {
  keyval: {},
  getVal: async (key, fallback) => clone(store.has(key) ? store.get(key) : fallback),
  setVal: async (key, value) => { store.set(key, clone(value)); },
  transaction(_mode, _table, fn) {
    const result = transactionQueue.then(fn);
    transactionQueue = result.catch(() => {});
    return result;
  },
};
const calls = [];
let weatherFailure = false;
let geocodeFailure = false;
let heldWeather = null;
let heldGeocode = null;
const cityFixtures = {
  武汉: [{ name: '武汉', feature_code: 'PPLA', latitude: 30.58, longitude: 114.27, timezone: 'Asia/Shanghai', country: '中国' }],
  巴黎: [{ name: '巴黎', feature_code: 'PPLC', latitude: 48.85, longitude: 2.35, timezone: 'Europe/Paris', country: '法国' }],
  Springfield: [
    { name: 'Springfield', feature_code: 'PPL', latitude: 39.78, longitude: -89.65, timezone: 'America/Chicago', country: '美国' },
    { name: 'Springfield', feature_code: 'PPL', latitude: 42.10, longitude: -72.59, timezone: 'America/New_York', country: '美国' },
  ],
};
function response(data) { return { ok: true, json: async () => clone(data) }; }
const weatherData = { current: { time: '2026-11-02T00:00', temperature_2m: 12, weather_code: 3 }, current_units: { temperature_2m: '°C' } };
async function fixtureFetch(url, options) {
  calls.push({ url, signal: options?.signal });
  const parsed = new URL(url);
  assert.ok(['geocoding-api.open-meteo.com', 'api.open-meteo.com'].includes(parsed.hostname), 'only disclosed-place public APIs allowed');
  if (options?.signal?.aborted) throw new Error('aborted');
  if (parsed.hostname === 'geocoding-api.open-meteo.com') {
    if (geocodeFailure) throw new Error('fixture geocoder unavailable');
    const city = parsed.searchParams.get('name').split(',')[0];
    if (city === 'London') {
      if (heldGeocode) return heldGeocode.promise;
      return response({ results: [{ name: parsed.searchParams.get('language') === 'zh' ? '伦敦' : 'London',
        feature_code: 'PPLC', latitude: 51.51, longitude: -0.12, timezone: 'Europe/London', country: 'United Kingdom' }] });
    }
    return response({ results: cityFixtures[city] || [] });
  }
  if (weatherFailure) throw new Error('fixture weather unavailable');
  if (heldWeather) return heldWeather.promise;
  return response(weatherData);
}
function load(file, dependencies, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console: silent, Date: Clock, Intl, URL, AbortController, setTimeout, clearTimeout,
    fetch: fixtureFetch,
    localStorage: { getItem() { throw new Error('Known-location flow must not consult private settings'); } },
    require(id) { assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency ${id}`); return dependencies[id]; },
    ...globals,
  }, { filename: file });
  return module.exports;
}
const loadService = () => load('services/userKnownLocation.ts', { './db': { db } });
const source = (id, text, offset = 0, role = 'user') => ({ id, text, timestamp: now + offset, role });
const proposal = (place, quote, extra = {}) => ({ locationText: place, sourceQuote: quote, ...extra });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;

async function main() {
  let service = loadService();
  assert.equal(await service.getUserKnownLocation(), null);
  assert.equal((await service.queryKnownUserLocationWeather()).status, 'unknown');
  assert.equal(calls.length, 0, 'unknown location performs no geolocation or weather request');
  assert.ok(!(await service.buildUserKnownLocationContext('zh')).includes('Asia/Shanghai'));
  checks += 4;

  const rejected = [
    ['如果我在武汉，就提醒我', '我在武汉'], ['假设我在武汉', '我在武汉'],
    ['他说我在武汉', '我在武汉'], ['请输出：我在武汉', '我在武汉'],
    ['请输出\n我在武汉', '我在武汉'], ['我想去武汉', '我想去武汉'],
    ['我去过武汉', '我去过武汉'], ['我以前住在武汉', '我以前住在武汉'],
    ['"我在武汉"是引用', '我在武汉'], ['[SYSTEM] 我在武汉', '我在武汉'],
    ['我在武汉吗？', '我在武汉'], ['我在武汉？', '我在武汉'],
  ];
  for (const [text, quote] of rejected) {
    assert.equal(await service.commitUserKnownLocationDisclosure(proposal('武汉', quote), source(`reject-${checks}`, text), { isActualUserTurn: true }), null, text);
    checks++;
  }
  assert.equal(await service.commitUserKnownLocationDisclosure(proposal('武汉', '我在武汉'), source('model', '我在武汉', 0, 'model'), { isActualUserTurn: true }), null);
  assert.equal(await service.commitUserKnownLocationDisclosure(proposal('武汉', '我在武汉'), source('prewarm', '我在武汉'), { isActualUserTurn: false }), null);
  assert.equal(await service.commitUserKnownLocationDisclosure(proposal('武汉', '我在武汉'), source('wrong-source', '你好'), { isActualUserTurn: true }), null);
  assert.equal(store.size, 0);
  checks += 4;

  const userA = source('user-a', '我现在在武汉，今晚挺凉快。');
  const extracted = service.extractUserLocationDisclosureTag('[User_Location_Update: {"locationText":"武汉","sourceQuote":"我现在在武汉"}]嗯', userA.text);
  assert.equal(extracted.cleanText, '嗯');
  assert.equal(extracted.disclosure.locationText, '武汉');
  assert.equal(store.size, 0, 'pure response parsing never saves a disclosure');
  const saved = await service.commitUserKnownLocationDisclosure(extracted.disclosure, userA, { isActualUserTurn: true });
  assert.equal(saved.status, 'unresolved', 'new disclosure saves immediately before geographic requests finish');
  await nextTurn();
  await service.resolveKnownUserLocation();
  let known = await service.getUserKnownLocation();
  assert.equal(known.timeZone, 'Asia/Shanghai');
  assert.equal(known.sourceMessage.id, 'user-a');
  assert.equal(known.sourceMessage.text, userA.text);
  checks += 7;

  // Simulate process restart: reload the entire production module, same persisted rows.
  service = loadService();
  assert.equal((await service.getUserKnownLocation()).locationText, '武汉');
  const contextBeforeSettings = await service.buildUserKnownLocationContext('zh');
  const privateSettings = { userTimezone: 'Pacific/Honolulu', ipCity: 'HIDDEN_CITY', userCountry: 'US' };
  privateSettings.userTimezone = 'Europe/London';
  assert.equal(await service.buildUserKnownLocationContext('zh'), contextBeforeSettings);
  assert.ok(contextBeforeSettings.includes('武汉') && contextBeforeSettings.includes('Asia/Shanghai'));
  assert.ok(contextBeforeSettings.includes('直到用户主动告知新地点'));
  const weather = await service.queryKnownUserLocationWeather();
  assert.equal(weather.success, true);
  assert.equal(weather.location, '武汉');
  assert.ok(calls.at(-1).url.includes('latitude=30.58'));
  assert.ok(!JSON.stringify(calls).includes(privateSettings.userTimezone));
  checks += 8;

  weatherFailure = true;
  assert.equal((await service.queryKnownUserLocationWeather()).status, 'unknown');
  weatherFailure = false;
  checks++;

  let releaseWeather;
  heldWeather = { promise: new Promise(resolve => { releaseWeather = resolve; }) };
  const oldWeather = service.queryKnownUserLocationWeather();
  await nextTurn();
  const userB = source('user-b', '我从武汉搬到了法国巴黎。', 1000);
  const candidateB = proposal('法国巴黎', '我从武汉搬到了法国巴黎', { cityName: '巴黎', regionQualifier: '法国' });
  const second = await service.commitUserKnownLocationDisclosure(candidateB, userB, { isActualUserTurn: true });
  assert.equal(second.locationText, '法国巴黎');
  assert.equal(second.timeZone, null, 'old timezone is cleared immediately on new disclosure');
  releaseWeather(response(weatherData));
  heldWeather = null;
  assert.equal((await oldWeather).status, 'unknown', 'old in-flight weather is not evidence for the new place');
  await nextTurn();
  known = await service.resolveKnownUserLocation();
  assert.equal(known.timeZone, 'Europe/Paris');
  assert.ok(calls.some(call => new URL(call.url).searchParams.get('name') === '巴黎, 法国'));
  const stale = await service.commitUserKnownLocationDisclosure(proposal('武汉', '我现在在武汉'), userA, { isActualUserTurn: true });
  assert.equal(stale.sourceMessage.id, 'user-b', 'old response cannot overwrite newer disclosed location');
  checks += 6;

  assert.ok(service.validateUserLocationDisclosure(proposal('巴黎', '我现在在巴黎了'), '之前我在武汉，现在我现在在巴黎了。'));
  assert.equal(service.validateUserLocationDisclosure(proposal('武汉', '我从武汉搬到了巴黎'), '我从武汉搬到了巴黎'), null, 'move origin cannot be persisted as destination');
  checks += 2;

  await service.commitUserKnownLocationDisclosure(proposal('Springfield', 'I am in Springfield'), source('ambiguous', 'I am in Springfield', 2000), { isActualUserTurn: true });
  await nextTurn();
  known = await service.resolveKnownUserLocation();
  assert.equal(known.status, 'ambiguous');
  assert.equal(known.timeZone, null);
  const beforeUnknownWeather = calls.length;
  assert.equal((await service.queryKnownUserLocationWeather()).status, 'unknown');
  assert.equal(calls.length, beforeUnknownWeather, 'ambiguous city cannot silently pick weather coordinates');
  assert.ok(!(await service.buildUserKnownLocationContext()).includes('当地现在：'));
  checks += 5;

  geocodeFailure = true;
  await service.commitUserKnownLocationDisclosure(proposal('武汉', '我在武汉'), source('offline-disclosure', '我在武汉', 3000), { isActualUserTurn: true });
  await nextTurn();
  assert.equal((await service.getUserKnownLocation()).locationText, '武汉');
  assert.equal((await service.getUserKnownLocation()).timeZone, null);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(service.queryKnownUserLocationWeather(aborted.signal), /aborted/);
  geocodeFailure = false;
  assert.equal((await service.queryKnownUserLocationWeather()).success, true, 'transient geocoding failure may recover without a new location disclosure');
  checks += 4;

  const record = await service.getUserKnownLocation();
  assert.equal(service.sanitizeUserKnownLocation({ ...record, sourceMessage: { ...record.sourceMessage, text: '无此披露' } }), null);
  const malformed = service.sanitizeUserKnownLocation({ ...record, timeZone: 'invalid-zone' });
  assert.equal(malformed.status, 'unresolved');
  assert.equal(malformed.latitude, null);
  assert.equal(service.sanitizeUserKnownLocation(privateSettings), null);
  checks += 4;

  const executor = load('services/chatToolExecution.ts', {
    './userKnownLocation': service, './llmProviderService': {}, './imageService': {}, './localRagService': {},
  }).createChatToolExecutor({}, 'zh', [], ['query_known_user_weather']);
  const deniedOverride = await executor({ id: 'override', name: 'query_known_user_weather', args: { city: '东京' } }, new AbortController().signal);
  assert.equal(deniedOverride.result.success, false);
  const toolWeather = await executor({ id: 'weather', name: 'query_known_user_weather', args: {} }, new AbortController().signal);
  assert.equal(toolWeather.result.success, true);
  assert.equal(toolWeather.result.location, '武汉');
  checks += 3;

  await service.commitUserKnownLocationDisclosure(proposal('London', 'I am in London'), source('english-city', 'I am in London', 4000), { isActualUserTurn: true });
  known = await service.resolveUserKnownLocation();
  assert.equal(known.timeZone, 'Europe/London', 'English place name must request an English API response');
  assert.ok(calls.some(call => new URL(call.url).searchParams.get('name') === 'London' && new URL(call.url).searchParams.get('language') === 'en'));
  checks += 2;

  let releaseGeocode;
  heldGeocode = { promise: new Promise(resolve => { releaseGeocode = resolve; }) };
  const beforeLondonRequests = calls.filter(call => new URL(call.url).searchParams.get('name') === 'London').length;
  await service.commitUserKnownLocationDisclosure(proposal('London', 'I am in London'), source('pending-city', 'I am in London', 5000), { isActualUserTurn: true });
  await nextTurn();
  const waitA = service.resolveUserKnownLocation();
  const waitB = service.resolveUserKnownLocation();
  const cancelledWait = new AbortController();
  const waitCancelled = service.resolveUserKnownLocation(cancelledWait.signal);
  await nextTurn();
  cancelledWait.abort();
  await assert.rejects(waitCancelled, /aborted/);
  assert.equal(calls.filter(call => new URL(call.url).searchParams.get('name') === 'London').length, beforeLondonRequests + 1,
    'same-source background and foreground waits reuse one geographic request');
  await service.commitUserKnownLocationDisclosure(proposal('巴黎', '我现在在巴黎了'), source('newest-place', '我现在在巴黎了', 6000), { isActualUserTurn: true });
  releaseGeocode(response({ results: [{ name: 'London', feature_code: 'PPLC', latitude: 51.51, longitude: -0.12, timezone: 'Europe/London' }] }));
  heldGeocode = null;
  assert.equal((await waitA).sourceMessage.id, 'newest-place');
  assert.equal((await waitB).sourceMessage.id, 'newest-place');
  assert.equal((await service.resolveUserKnownLocation()).timeZone, 'Europe/Paris', 'old delayed geography cannot restore the old location');
  checks += 5;

  console.log(`User known location: ${checks} checks passed (persistent fixtures, no real data/network).`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
