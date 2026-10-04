// Minimal in-memory stand-ins for the Apps Script services Code.gs uses.
const crypto = require('crypto');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function loadServer() {
  let idc = 0;
  const nid = (p) => p + (++idc).toString().padStart(12, '0') + 'xyz';
  const toBuf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff)));
  const signed = (b) => Array.from(b).map((x) => (x > 127 ? x - 256 : x));

  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.max = 1000; this.fmt = {}; }
    getMaxRows() { return this.max; }
    insertRowsAfter(_a, n) { this.max += n; }
    getLastRow() { let l = 0; this.data.forEach((r, i) => { if (r && r.some((c) => c !== '' && c !== undefined)) l = i + 1; }); return l; }
    setName(n) { this.name = n; }
    setFrozenRows() {}
    getRange(r, c, nr = 1, nc = 1) {
      const sh = this;
      if (r + nr - 1 > sh.max) throw new Error('range outside sheet: ' + (r + nr - 1) + ' > ' + sh.max);
      return {
        setNumberFormat() { return this; },
        setValues(v) { v.forEach((row, i) => row.forEach((x, j) => { (sh.data[r - 1 + i] = sh.data[r - 1 + i] || [])[c - 1 + j] = x; })); return this; },
        setValue(x) { (sh.data[r - 1] = sh.data[r - 1] || [])[c - 1] = x; return this; },
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const x = (sh.data[r - 1 + i] || [])[c - 1 + j]; row.push(x === undefined ? '' : x); } o.push(row); } return o; },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (sh.data[r - 1 + i]) sh.data[r - 1 + i][c - 1 + j] = ''; return this; },
      };
    }
  }
  class Spreadsheet {
    constructor() { this.id = nid('ss'); this.sheets = [new Sheet('Sheet1')]; }
    getSheets() { return this.sheets; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getId() { return this.id; }
    getUrl() { return 'https://sheet/' + this.id; }
  }
  const sheets = {}; const files = {}; const folders = {};
  class File {
    constructor(name, mime, bytes, parent) { this.id = nid('file'); this.name = name; this.mime = mime; this.bytes = bytes; this.parent = parent; this.trashed = false; files[this.id] = this; this.created = Date.now() + idc; }
    getId() { return this.id; } getName() { return this.name; }
    getParents() { const p = this.parent ? [this.parent] : []; let i = 0; return { hasNext: () => i < p.length, next: () => p[i++] }; }
    getBlob() { const f = this; return { getContentType: () => f.mime, getBytes: () => signed(f.bytes) }; }
    setTrashed(t) { this.trashed = t; return this; }
    getDateCreated() { return new Date(this.created); }
    makeCopy(n, folder) { return new File(n, this.mime, this.bytes, folder); }
  }
  class Folder {
    constructor(name) { this.id = nid('fold'); this.name = name; folders[this.id] = this; }
    getId() { return this.id; } getUrl() { return 'https://folder/' + this.id; }
    createFolder(n) { return new Folder(n); }
    createFile(blob) { return new File(blob.name, blob.mime, blob.bytes, this); }
    getFiles() { const l = Object.values(files).filter((f) => f.parent === this && !f.trashed); let i = 0; return { hasNext: () => i < l.length, next: () => l[i++] }; }
  }
  const store = {}; const cache = {};
  let spreadsheet;
  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, Error, Buffer,
    Logger: { log: (...a) => ctx.__log.push(a) }, __log: [],
    SpreadsheetApp: {
      create() { spreadsheet = new Spreadsheet(); sheets[spreadsheet.id] = spreadsheet; const f = new File('ss', 'sheet', Buffer.from(''), null); delete files[f.id]; f.id = spreadsheet.id; files[f.id] = f; return spreadsheet; },
      openById(id) { return sheets[id]; },
    },
    DriveApp: {
      createFolder: (n) => new Folder(n),
      getFolderById: (id) => { if (!folders[id]) throw new Error('no folder'); return folders[id]; },
      getFileById: (id) => { if (!files[id]) throw new Error('no file'); return files[id]; },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperties: (o) => Object.assign(store, o) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Africa/Addis_Ababa' },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() {} }) }) }) }) },
    // Real Apps Script: addMetaTag only accepts 'viewport' and 'theme-color' and throws
    // "The meta tag that you've specified is not allowed in this context" for anything else —
    // that's what caught the mobile-web-app-capable bug; keep enforcing it so it can't recur.
    HtmlService: {
      createHtmlOutputFromFile(name) {
        const html = fs.readFileSync(path.join(__dirname, '../apps-script/', name + '.html'), 'utf8');
        const out = {
          _title: null, _metas: {},
          setTitle(t) { out._title = t; return out; },
          addMetaTag(tag, content) {
            if (tag !== 'viewport' && tag !== 'theme-color') {
              throw new Error("The meta tag that you've specified is not allowed in this context.");
            }
            out._metas[tag] = content; return out;
          },
          getContent: () => html,
        };
        return out;
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_a, v) => signed(crypto.createHash('sha256').update(toBuf(v)).digest()),
      computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', k).update(v).digest()),
      base64Encode: (b) => (typeof b === 'string' ? Buffer.from(b) : toBuf(b)).toString('base64'),
      base64EncodeWebSafe: (b) => toBuf(b).toString('base64url') + '==',
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes, mime, name) => ({ bytes: toBuf(bytes), mime, name }),
      formatDate: () => '20260101-000000',
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  ctx.__files = files; ctx.__sheets = sheets; ctx.__cache = cache; ctx.__store = store;
  return ctx;
}
module.exports = { loadServer };
