import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'exporter.user.js'), 'utf8');

// ---------- fake IndexedDB ----------
class Req { constructor() { this.onsuccess = null; this.onerror = null; } }
class FakeTx {
  constructor(db) { this.db = db; this.oncomplete = null; this.onerror = null; this.onabort = null; }
  objectStore() { return {
    get: k => { const r = new Req(); queueMicrotask(() => { r.result = this.db.map.get(k); r.onsuccess?.(); this.db._txDone(this); }); return r; },
    put: (v, k) => { const r = new Req(); queueMicrotask(() => { this.db.map.set(k, structuredClone(v)); r.onsuccess?.(); this.db._txDone(this); }); return r; },
    count: rg => { const r = new Req(); queueMicrotask(() => { let n = 0; for (const k of this.db.map.keys()) if (rg._has(k)) n++; r.result = n; r.onsuccess?.(); this.db._txDone(this); }); return r; },
    delete: rg => { const r = new Req(); queueMicrotask(() => { for (const k of [...this.db.map.keys()]) if (rg._has(k)) this.db.map.delete(k); r.onsuccess?.(); this.db._txDone(this); }); return r; }
  }; }
}
class FakeDB {
  constructor() { this.map = new Map(); }
  _txDone(tx) { setTimeout(() => tx.oncomplete?.(), 0); }
  transaction() { return new FakeTx(this); }
  close() {}
}
const fakeDB = new FakeDB();
const IDBKeyRange = {
  bound: (lo, hi, li = true, hiInc = true) => ({ _lo: lo, _hi: hi, _li: li, _hiI: hiInc, _has: k => (li ? k >= lo : k > lo) && (hiInc ? k <= hi : k < hi) })
};
globalThis.indexedDB = { open: () => { const r = new Req(); queueMicrotask(() => { r.result = fakeDB; r.onsuccess?.(); }); return r; } };
globalThis.IDBKeyRange = IDBKeyRange;

// ---------- fake DOM & misc ----------
const makeEl = () => ({ style: {}, classList: { add(){}, remove(){}, contains: () => false }, dataset: {},
  setAttribute(){}, getAttribute: () => null, removeAttribute(){}, appendChild(){}, removeChild(){},
  addEventListener(){}, remove(){}, matches: () => false, focus(){},
  querySelector: () => null, querySelectorAll: () => [], textContent: '', innerHTML: '', title: '', disabled: false,
  type: '', id: '', click(){}, offsetWidth: 0, offsetHeight: 0, setPointerCapture(){},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
globalThis.document = { cookie: 'oai-did=test-device;', head: makeEl(), body: makeEl(), documentElement: makeEl(),
  getElementById: () => null, createElement: makeEl };
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){}, length: 0, key: () => null };
globalThis.location = { origin: 'https://chatgpt.com' };
const FakeURL = class {};
FakeURL.createObjectURL = () => 'blob:x';
FakeURL.revokeObjectURL = () => {};
globalThis.URL = FakeURL;
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.XMLHttpRequest = class {
  open() {}
  addEventListener() {}
  getRequestHeader() { return null; }
};
globalThis.Headers = class {
  constructor(init) { this._m = new Map(Object.entries(init || {})); }
  get(k) { return this._m.get(String(k).toLowerCase()) ?? null; }
};
globalThis.__alerts = []; globalThis.__confirmAnswer = false;
globalThis.alert = msg => { globalThis.__alerts.push(String(msg)); };
globalThis.confirm = () => globalThis.__confirmAnswer;

// ---------- fake JSZip ----------
class JSZip {
  constructor() { this.files = new Map(); }
  file(name, data) { this.files.set(name, data); }
  folder(name) { const zip = this; return { file: (n, d) => zip.files.set(`${name}/${n}`, d), folder: n2 => zip.folder(`${name}/${n2}`) }; }
  async generateAsync() { return { size: 123 }; }
}
globalThis.JSZip = JSZip;

// ---------- fetch stub (scenario state) ----------
const state = {
  sessionToken: 'tok-' + Math.random().toString(36).slice(2),
  conversations: new Map(),
  brokenIds: new Set(),
  fetchLog: []
};
let fetchImpl = async (url) => {
  state.fetchLog.push(String(url));
  const u = String(url);
  if (u.startsWith('/api/auth/session')) {
    return { ok: true, json: async () => ({ accessToken: state.sessionToken }) };
  }
  if (u.startsWith('/backend-api/conversations?')) {
    return { ok: true, json: async () => ({ items: [...state.conversations.keys()].map(id => ({ id, title: 'Conv ' + id })), cursor: null }) };
  }
  const m = u.match(/^\/backend-api\/conversation\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (state.brokenIds.has(id)) {
      return { ok: false, status: 429, headers: { get: k => (k || '').toLowerCase() === 'retry-after' ? '0' : null } };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => state.conversations.get(id) };
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
};
globalThis.fetch = (url, opts) => fetchImpl(url, opts);

// ---------- load real exporter ----------
const sandbox = { console, setTimeout, clearTimeout, JSON, Date, Math, Promise, Uint8Array, structuredClone };
Object.assign(sandbox, {
  document: globalThis.document, localStorage: globalThis.localStorage, location: globalThis.location,
  alert: globalThis.alert, confirm: globalThis.confirm, indexedDB: globalThis.indexedDB, IDBKeyRange,
  JSZip, fetch: globalThis.fetch, CustomEvent: globalThis.CustomEvent, URL: FakeURL,
  XMLHttpRequest: globalThis.XMLHttpRequest, Headers: globalThis.Headers
});
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.dispatchEvent = () => {};
sandbox.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(CODE, sandbox, { filename: 'exporter.user.js' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitAlert = async (timeoutMs = 90000) => {
  const start = Date.now();
  while (globalThis.__alerts.length === 0 && Date.now() - start < timeoutMs) await sleep(200);
};
process.on('unhandledRejection', e => console.error('UNHANDLED:', e));
let failed = 0;
const assert = (cond, msg) => { if (!cond) { failed++; console.error('FAIL:', msg); } else console.log('PASS:', msg); };
const convFetches = () => state.fetchLog.filter(u => u.startsWith('/backend-api/conversation/')).length;
const listFetches = () => state.fetchLog.filter(u => u.startsWith('/backend-api/conversations?')).length;

// ---------- Scenario A: interrupt -> resume ----------
for (const id of ['c1', 'c2', 'c3', 'c4']) {
  state.conversations.set(id, { conversation_id: id, title: 'Conv ' + id, mapping: {} });
}
state.brokenIds.add('c2');

console.log('--- Run 1: c2 keeps returning 429 ---');
await sandbox.ChatGPTExporter.startManualExport('personal', null);
await sleep(300);
assert(convFetches() === 3 + 6, `run1 detail fetches = 3 convs + 6 for c2 (1 initial + 5 retries) = 9, got ${convFetches()}`);
assert(fakeDB.map.size === 3, `run1 cached 3 conversations (c2 failed, not cached), got ${fakeDB.map.size}`);
assert(globalThis.__alerts[0].includes('1 个对话获取失败'), 'run1 alert reports 1 failed conversation');
assert(globalThis.__alerts[0].includes('断点续传'), 'run1 alert mentions resume');

console.log('--- Run 2: c2 fixed, resume enabled ---');
state.fetchLog = []; state.brokenIds.clear(); globalThis.__alerts = []; globalThis.__confirmAnswer = true;
await sandbox.ChatGPTExporter.startManualExport('personal', null);
await sleep(300);
assert(convFetches() === 1, `run2 fetches ONLY c2 (1 detail request), got ${convFetches()}`);
assert(globalThis.__alerts[0].includes('复用本地缓存 3 个对话'), 'run2 alert says reused 3 cached conversations');
assert(fakeDB.map.size === 0, 'run2 all succeeded -> cache cleared');
assert(listFetches() === 2, 'run2 still re-lists conversations (fresh ID list), got ' + listFetches());

console.log('--- Run 3: decline resume -> cache cleared ---');
globalThis.__alerts = []; globalThis.__confirmAnswer = false;
state.brokenIds.add('c3');
await sandbox.ChatGPTExporter.startManualExport('personal', null);
await sleep(300);
state.brokenIds.clear();
globalThis.__confirmAnswer = true;
console.log('--- Run 4: c3 fixed, resume picks up c3 only ---');
state.fetchLog = []; globalThis.__alerts = [];
await sandbox.ChatGPTExporter.startManualExport('personal', null);
await sleep(300);
assert(convFetches() === 1, `run4 fetches only c3 from cache-miss, got ${convFetches()}`);

// ---------- Scenario B: attachments cached, full success clears cache ----------
console.log('--- Run 5: with attachments, all succeed ---');
state.conversations.clear();
state.conversations.set('a1', {
  conversation_id: 'a1', title: 'AttConv',
  mapping: { n1: { message: { id: 'm1', author: { role: 'user' },
    content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'file-service://file-abc123', content_type: 'image' }] } } } }
});
state.fetchLog = []; globalThis.__alerts = []; globalThis.__confirmAnswer = false;
fetchImpl = async (url) => {
  state.fetchLog.push(String(url));
  const u = String(url);
  if (u.startsWith('/api/auth/session')) return { ok: true, json: async () => ({ accessToken: state.sessionToken }) };
  if (u.startsWith('/backend-api/conversations?')) return { ok: true, json: async () => ({ items: [{ id: 'a1', title: 'AttConv' }], cursor: null }) };
  if (u.startsWith('/backend-api/conversation/')) {
    const id = decodeURIComponent(u.split('/conversation/')[1]);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => state.conversations.get(id) };
  }
  if (u.startsWith('/backend-api/files/download/')) {
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ download_url: 'https://cdn.example.com/blob?sig=1', file_name: 'pic.png' }) };
  }
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
};
sandbox.fetch = fetchImpl;

await sandbox.ChatGPTExporter.startScheduledExport({ mode: 'personal', includeAttachments: true, autoConfirm: true });
await waitAlert();
const detailCalls = state.fetchLog.filter(u => u.startsWith('/backend-api/conversation/')).length;
const fileCalls = state.fetchLog.filter(u => u.startsWith('/backend-api/files/download/')).length;
assert(detailCalls === 1 && fileCalls === 1, `run5 fetched 1 conv + 1 attachment metadata, got ${detailCalls}/${fileCalls}`);
assert(fakeDB.map.size === 0, 'run5 fully succeeded -> cache cleared even with attachments');
assert(globalThis.__alerts[0].includes('附件：检测 1，成功 1'), 'run5 attachment report OK');

console.log('--- Run 6: 500 without Retry-After -> exponential backoff ---');
state.fetchLog = []; globalThis.__alerts = [];
const prev = fetchImpl;
fetchImpl = async (url) => {
  const u = String(url);
  if (u.startsWith('/backend-api/conversation/a1')) {
    return { ok: false, status: 500, headers: { get: () => null } };
  }
  return prev(url);
};
sandbox.fetch = fetchImpl;
const t0 = Date.now();
await sandbox.ChatGPTExporter.startScheduledExport({ mode: 'personal', includeAttachments: true, autoConfirm: true });
await waitAlert();
assert(fakeDB.map.size === 0, 'run6 conv failed -> nothing cached');
assert(Date.now() - t0 > 1500, `run6 exponential backoff actually waited (${Date.now() - t0}ms)`);

console.log('--- Run 7: attachments interrupted -> resume restores cached binaries ---');
state.conversations.clear();
const mkConv = id => ({
  conversation_id: id, title: 'AttConv ' + id,
  mapping: { n1: { message: { id: 'm1', author: { role: 'user' },
    content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'file-service://file-' + id, content_type: 'image' }] } } } }
});
state.conversations.set('a1', mkConv('a1'));
state.conversations.set('a2', mkConv('a2'));
state.fetchLog = []; globalThis.__alerts = []; globalThis.__confirmAnswer = false;
fetchImpl = async (url) => {
  state.fetchLog.push(String(url));
  const u = String(url);
  if (u.startsWith('/backend-api/conversations?')) {
    return { ok: true, json: async () => ({ items: [...state.conversations.keys()].map(id => ({ id, title: 'AttConv ' + id })), cursor: null }) };
  }
  const m = u.match(/^\/backend-api\/conversation\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (id === 'a2') return { ok: false, status: 429, headers: { get: k => (k || '').toLowerCase() === 'retry-after' ? '0' : null } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => state.conversations.get(id) };
  }
  if (u.startsWith('/backend-api/files/download/')) {
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ download_url: 'https://cdn.example.com/blob?sig=1', file_name: 'pic.png' }) };
  }
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
};
sandbox.fetch = fetchImpl;
await sandbox.ChatGPTExporter.startScheduledExport({ mode: 'personal', includeAttachments: true, autoConfirm: true });
await waitAlert();
assert(fakeDB.map.size === 1, `run7a cached 1 conversation (a2 failed), got ${fakeDB.map.size}`);
const cachedRec = [...fakeDB.map.values()][0];
assert(cachedRec.attachmentResult?.files?.[0]?.data instanceof Uint8Array &&
  [...cachedRec.attachmentResult.files[0].data].join() === '1,2,3',
  'run7a cached record stores attachment binary (Uint8Array 1,2,3)');
assert(globalThis.__alerts[0].includes('1 个对话获取失败'), 'run7a alert reports the failed conversation');

state.fetchLog = []; globalThis.__alerts = []; globalThis.__confirmAnswer = true;
fetchImpl = async (url) => {
  state.fetchLog.push(String(url));
  const u = String(url);
  if (u.startsWith('/backend-api/conversations?')) {
    return { ok: true, json: async () => ({ items: [...state.conversations.keys()].map(id => ({ id, title: 'AttConv ' + id })), cursor: null }) };
  }
  const m = u.match(/^\/backend-api\/conversation\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => state.conversations.get(id) };
  }
  if (u.startsWith('/backend-api/files/download/')) {
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ download_url: 'https://cdn.example.com/blob?sig=1', file_name: 'pic.png' }) };
  }
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
};
sandbox.fetch = fetchImpl;
await sandbox.ChatGPTExporter.startScheduledExport({ mode: 'personal', includeAttachments: true, autoConfirm: true });
await waitAlert();
const r7detail = state.fetchLog.filter(u => u.startsWith('/backend-api/conversation/')).length;
const r7meta = state.fetchLog.filter(u => u.startsWith('/backend-api/files/download/')).length;
assert(r7detail === 1, `run7b fetched only a2 conversation (a1 from cache), got ${r7detail}`);
assert(r7meta === 1, `run7b downloaded attachment only for a2 (a1 binary restored from cache), got ${r7meta}`);
assert(globalThis.__alerts[0].includes('复用本地缓存 1 个对话'), 'run7b alert says reused 1 cached conversation');
assert(globalThis.__alerts[0].includes('附件：检测 2，成功 2'), 'run7b report counts BOTH conversations attachments (cached + fresh)');
assert(fakeDB.map.size === 0, 'run7b full success -> cache cleared');

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
