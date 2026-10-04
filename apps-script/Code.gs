/**
 * Birr Ledger — Apps Script backend.
 *
 * Runs as the OWNER (webapp.executeAs = USER_DEPLOYING). End users never get access to the
 * Sheet, the Drive folder or the script: they sign in with an app-level username + password
 * that only this file checks. Data lives in a Google Sheet, receipts live in Drive.
 *
 * First-time setup: run setup() once from the editor (see SETUP.md).
 */

const CFG = {
  APP_NAME: 'Birr Ledger',
  ADMIN_USERNAME: 'admin',
  SESSION_DAYS: 30,
  MAX_FAILS: 5,                 // wrong passwords per username ...
  LOCK_SECONDS: 15 * 60,        // ... before that username is locked for this long
  MAX_UPLOAD_BYTES: 6 * 1024 * 1024,
  MAX_ATT_PER_ENTRY: 5,
  MAX_ENTRY_JSON: 8000,
  MAX_META_JSON: 400000,
  CELL_CHUNK: 40000,            // a cell holds 50,000 chars; stay under it
  BACKUP_KEEP: 14,
  ALLOWED_MIME: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
};

const USER_COLS = ['userId', 'username', 'name', 'role', 'salt', 'hash', 'active', 'tokenVer', 'rev', 'folderId', 'createdAt'];
const AUDIT_COLS = ['ts', 'adminUsername', 'targetUsername', 'action'];
const AUDIT_KEEP = 500;

// ---------------------------------------------------------------- web app entry

function doGet() {
  // Apps Script's addMetaTag only accepts 'viewport' and 'theme-color' — anything else throws
  // "meta tag ... not allowed in this context". The rest of the tags (mobile-web-app-capable etc.)
  // are already written directly into Index.html's own <head>, so nothing is lost by not adding
  // them here too.
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CFG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('theme-color', '#0F1418');
}

/** Single RPC entry point called from the page via google.script.run.rpc(method, token, args). */
function rpc(method, token, args) {
  try {
    args = args || {};
    if (method === 'login') return ok_(login_(args));
    const user = auth_(token);
    switch (method) {
      case 'load':           return ok_(load_(user));
      case 'adminLoad':      requireAdmin_(user); return ok_(adminLoad_(user, args));
      case 'listAudit':      requireAdmin_(user); return ok_(listAudit_());
      case 'save':           return save_(user, args);
      case 'upload':         return ok_(upload_(user, args));
      case 'file':           return ok_(getFile_(user, args));
      case 'changePassword': return ok_(changePassword_(user, args));
      case 'listUsers':      requireAdmin_(user); return ok_(listUsers_());
      case 'createUser':     requireAdmin_(user); return ok_(createUser_(user, args));
      case 'resetPassword':  requireAdmin_(user); return ok_(resetPassword_(user, args));
      case 'setActive':      requireAdmin_(user); return ok_(setActive_(user, args));
      default: throw err_('BAD_METHOD', 'Unknown method.');
    }
  } catch (e) {
    if (e && e.appCode) return { ok: false, code: e.appCode, msg: e.message };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, code: 'SERVER', msg: 'Server error. Try again in a moment.' };
  }
}

function ok_(data) { return { ok: true, data: data }; }
function err_(code, msg) { const e = new Error(msg); e.appCode = code; return e; }

// ---------------------------------------------------------------- one-time setup & admin recovery

/** Run once from the editor. Creates the data Sheet, the Drive folders, the secret and the admin user. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEET_ID')) {
    throw new Error('Already set up. To recover the admin password, run resetAdminPassword().');
  }
  const ss = SpreadsheetApp.create(CFG.APP_NAME + ' — data (do not share)');
  const users = ss.getSheets()[0];
  users.setName('Users');
  users.getRange(1, 1, 1, USER_COLS.length).setValues([USER_COLS]);
  users.getRange(1, 1, users.getMaxRows(), USER_COLS.length).setNumberFormat('@');
  users.setFrozenRows(1);
  const meta = ss.insertSheet('Meta');
  meta.getRange(1, 1, 1, 3).setValues([['userId', 'part', 'chunk']]);
  meta.getRange(1, 1, meta.getMaxRows(), 3).setNumberFormat('@');
  meta.setFrozenRows(1);
  const audit = ss.insertSheet('AuditLog');
  audit.getRange(1, 1, 1, AUDIT_COLS.length).setValues([AUDIT_COLS]);
  audit.getRange(1, 1, audit.getMaxRows(), AUDIT_COLS.length).setNumberFormat('@');
  audit.setFrozenRows(1);

  const root = DriveApp.createFolder(CFG.APP_NAME + ' — attachments (do not share)');
  const backups = DriveApp.createFolder(CFG.APP_NAME + ' — sheet backups');

  props.setProperties({
    SHEET_ID: ss.getId(),
    ROOT_FOLDER_ID: root.getId(),
    BACKUP_FOLDER_ID: backups.getId(),
    SECRET: randomString_(48, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  });

  const pw = generatePassword_();
  addUserRow_(CFG.ADMIN_USERNAME, 'Admin', 'admin', pw);
  Logger.log('SETUP DONE.\nAdmin username: %s\nAdmin password: %s\nSheet: %s\nAttachments folder: %s',
    CFG.ADMIN_USERNAME, pw, ss.getUrl(), root.getUrl());
}

/** Editor-only recovery: sets a new random admin password and signs the admin out everywhere. */
function resetAdminPassword() {
  const admin = findUserByName_(CFG.ADMIN_USERNAME);
  if (!admin) throw new Error('Admin user not found.');
  const pw = generatePassword_();
  withLock_(function () { setPassword_(admin.userId, pw); });
  Logger.log('New admin password: %s', pw);
}

/** Optional: nightly copy of the data Sheet into the backup folder (keeps the last BACKUP_KEEP). */
function installBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightlyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightlyBackup').timeBased().everyDays(1).atHour(2).create();
}

function nightlyBackup() {
  const folder = DriveApp.getFolderById(prop_('BACKUP_FOLDER_ID'));
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  DriveApp.getFileById(prop_('SHEET_ID')).makeCopy('ledger-data-' + stamp, folder);
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); files.push({ f: f, t: f.getDateCreated().getTime() }); }
  files.sort(function (a, b) { return b.t - a.t; });
  files.slice(CFG.BACKUP_KEEP).forEach(function (x) { x.f.setTrashed(true); });
}

// ---------------------------------------------------------------- auth

function login_(a) {
  const username = normUsername_(a.username);
  const password = String(a.password || '');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CFG.MAX_FAILS) {
    throw err_('LOCKED', 'Too many wrong attempts. Try again in 15 minutes.');
  }
  const user = username ? findUserByName_(username) : null;
  const good = user && user.active === 'yes' && safeEqual_(user.hash, hashPw_(user.salt, password));
  if (!good) {
    cache.put(failKey, String(fails + 1), CFG.LOCK_SECONDS);
    throw err_('BAD_LOGIN', 'Wrong username or password.');
  }
  cache.remove(failKey);
  return { token: makeToken_(user), user: publicUser_(user) };
}

function publicUser_(u) { return { id: u.userId, username: u.username, name: u.name, role: u.role }; }

function makeToken_(user) {
  const exp = Date.now() + CFG.SESSION_DAYS * 86400000;
  const payload = [user.userId, exp, user.tokenVer].join('.');
  return payload + '.' + sign_(payload);
}

function auth_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) throw err_('AUTH', 'Please sign in.');
  const payload = parts.slice(0, 3).join('.');
  if (!safeEqual_(parts[3], sign_(payload))) throw err_('AUTH', 'Please sign in.');
  if (Number(parts[1]) < Date.now()) throw err_('AUTH', 'Session expired. Please sign in.');
  const user = findUserById_(parts[0]);
  if (!user || user.active !== 'yes' || String(user.tokenVer) !== parts[2]) {
    throw err_('AUTH', 'Please sign in.');
  }
  return user;
}

function requireAdmin_(user) {
  if (user.role !== 'admin') throw err_('FORBIDDEN', 'Admin only.');
}

function sign_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, prop_('SECRET')));
}

function hashPw_(salt, password) {
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(salt + ':' + password, prop_('SECRET')));
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function setPassword_(userId, password) {
  const salt = randomString_(16, '0123456789abcdef');
  const u = findUserById_(userId);
  setUserFields_(userId, { salt: salt, hash: hashPw_(salt, password), tokenVer: Number(u.tokenVer) + 1 });
}

function changePassword_(user, a) {
  const next = String(a.next || '');
  if (next.length < 8) throw err_('WEAK', 'New password must be at least 8 characters.');
  if (!safeEqual_(user.hash, hashPw_(user.salt, String(a.current || '')))) {
    throw err_('BAD_LOGIN', 'Current password is wrong.');
  }
  return withLock_(function () {
    setPassword_(user.userId, next);               // bumps tokenVer: every other session is signed out
    return { token: makeToken_(findUserById_(user.userId)) };
  });
}

// ---------------------------------------------------------------- admin: users

function listUsers_() {
  return readUsers_().map(function (u) {
    return { id: u.userId, username: u.username, name: u.name, role: u.role, active: u.active === 'yes', createdAt: u.createdAt };
  });
}

function createUser_(admin, a) {
  const username = normUsername_(a.username);
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw err_('INVALID', 'Username: 3–30 characters, letters, digits, dot, dash or underscore.');
  }
  const name = cleanText_(a.name, 60) || username;
  return withLock_(function () {
    if (findUserByName_(username)) throw err_('EXISTS', 'That username is taken.');
    const pw = generatePassword_();
    const u = addUserRow_(username, name, 'user', pw);
    audit_(admin, u, 'created user');
    return { user: publicUser_(u), password: pw };
  });
}

function resetPassword_(admin, a) {
  return withLock_(function () {
    const u = findUserById_(String(a.userId || ''));
    if (!u) throw err_('NOT_FOUND', 'No such user.');
    const pw = generatePassword_();
    setPassword_(u.userId, pw);
    audit_(admin, u, 'reset password');
    return { password: pw };
  });
}

function setActive_(admin, a) {
  return withLock_(function () {
    const u = findUserById_(String(a.userId || ''));
    if (!u) throw err_('NOT_FOUND', 'No such user.');
    if (u.userId === admin.userId) throw err_('INVALID', 'You cannot disable yourself.');
    setUserFields_(u.userId, { active: a.active ? 'yes' : 'no', tokenVer: Number(u.tokenVer) + 1 });
    audit_(admin, u, a.active ? 'enabled user' : 'disabled user');
    return { ok: true };
  });
}

function addUserRow_(username, name, role, password) {
  const userId = 'u' + randomString_(10, 'abcdefghijklmnopqrstuvwxyz0123456789');
  const salt = randomString_(16, '0123456789abcdef');
  const folder = DriveApp.getFolderById(prop_('ROOT_FOLDER_ID')).createFolder(username + ' (' + userId + ')');
  const row = {
    userId: userId, username: username, name: name, role: role, salt: salt,
    hash: hashPw_(salt, password), active: 'yes', tokenVer: 1, rev: 0,
    folderId: folder.getId(), createdAt: new Date().toISOString()
  };
  const sh = usersSheet_();
  writeRows_(sh, sh.getLastRow() + 1, [USER_COLS.map(function (c) { return String(row[c]); })], USER_COLS.length);
  ledgerSheet_(userId);
  invalidateUsers_();
  return row;
}

// ---------------------------------------------------------------- users sheet access

let usersCache_ = null;
function invalidateUsers_() { usersCache_ = null; }

function usersSheet_() { return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName('Users'); }

function readUsers_() {
  if (usersCache_) return usersCache_;
  const sh = usersSheet_();
  const last = sh.getLastRow();
  const out = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, USER_COLS.length).getValues().forEach(function (r, i) {
      const u = { _row: i + 2 };
      USER_COLS.forEach(function (c, j) { u[c] = String(r[j]); });
      out.push(u);
    });
  }
  usersCache_ = out;
  return out;
}

function findUserById_(id) { return readUsers_().filter(function (u) { return u.userId === id; })[0] || null; }
function findUserByName_(name) { return readUsers_().filter(function (u) { return u.username === name; })[0] || null; }

function setUserFields_(userId, fields) {
  const u = findUserById_(userId);
  if (!u) throw err_('NOT_FOUND', 'No such user.');
  const sh = usersSheet_();
  Object.keys(fields).forEach(function (k) {
    sh.getRange(u._row, USER_COLS.indexOf(k) + 1).setNumberFormat('@').setValue(String(fields[k]));
  });
  invalidateUsers_();
}

// ---------------------------------------------------------------- ledger data

function ledgerSheet_(userId) {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const name = 'L_' + userId;
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, 2).setValues([['id', 'json']]);
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Writes a 2-D block of strings as plain text, growing the sheet first (setValues throws past the last row). */
function writeRows_(sh, startRow, rows, width) {
  if (!rows.length) return;
  const needed = startRow + rows.length - 1;
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows() + 500);
  sh.getRange(startRow, 1, rows.length, width).setNumberFormat('@').setValues(rows);
}

function readEntryRows_(sh) {
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, 2).getValues().map(function (r) { return [String(r[0]), String(r[1])]; });
}

function metaSheet_() { return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName('Meta'); }

function readMeta_(userId) {
  const sh = metaSheet_();
  const last = sh.getLastRow();
  if (last < 2) return {};
  const parts = sh.getRange(2, 1, last - 1, 3).getValues()
    .filter(function (r) { return String(r[0]) === userId; })
    .sort(function (a, b) { return Number(a[1]) - Number(b[1]); })
    .map(function (r) { return String(r[2]); });
  if (!parts.length) return {};
  try { return JSON.parse(parts.join('')); } catch (e) { return {}; }
}

function writeMeta_(userId, meta) {
  const json = JSON.stringify(meta);
  if (json.length > CFG.MAX_META_JSON) throw err_('TOO_BIG', 'Settings data is too large.');
  const sh = metaSheet_();
  const last = sh.getLastRow();
  const keep = last < 2 ? [] : sh.getRange(2, 1, last - 1, 3).getValues()
    .filter(function (r) { return String(r[0]) !== userId; })
    .map(function (r) { return [String(r[0]), String(r[1]), String(r[2])]; });
  for (let i = 0, p = 0; i < json.length || p === 0; i += CFG.CELL_CHUNK, p++) {
    keep.push([userId, String(p), json.slice(i, i + CFG.CELL_CHUNK)]);
  }
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).clearContent();
  writeRows_(sh, 2, keep, 3);
}

function load_(user) {
  const doc = readMeta_(user.userId);
  doc.entries = readEntryRows_(ledgerSheet_(user.userId)).map(function (r) {
    try { return JSON.parse(r[1]); } catch (e) { return null; }
  }).filter(Boolean);
  return { doc: doc, rev: Number(user.rev), user: publicUser_(user) };
}

/**
 * Admin-only, read-only view of another user's ledger. Never accepts writes for that user — there
 * is no "adminSave": an admin who wants to change someone's entries signs in as them via reset
 * password. Every call is appended to AuditLog so a look is never silent.
 */
function adminLoad_(admin, a) {
  const target = findUserById_(String(a.userId || ''));
  if (!target) throw err_('NOT_FOUND', 'No such user.');
  const doc = readMeta_(target.userId);
  doc.entries = readEntryRows_(ledgerSheet_(target.userId)).map(function (r) {
    try { return JSON.parse(r[1]); } catch (e) { return null; }
  }).filter(Boolean);
  audit_(admin, target, 'viewed ledger');
  return { doc: doc, rev: Number(target.rev), user: publicUser_(target) };
}

function listAudit_() {
  const sh = auditSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(Math.max(2, last - AUDIT_KEEP + 1), 1, last - Math.max(2, last - AUDIT_KEEP + 1) + 1, AUDIT_COLS.length)
    .getValues().map(function (r) { return { ts: r[0], admin: r[1], target: r[2], action: r[3] }; })
    .reverse();
}

function auditSheet_() { return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName('AuditLog'); }

/** Append-only; never edited or deleted from the app, so it stays a trustworthy record of admin access. */
function audit_(admin, target, action) {
  const sh = auditSheet_();
  writeRows_(sh, sh.getLastRow() + 1, [[new Date().toISOString(), admin.username, target.username, action]], AUDIT_COLS.length);
}

/**
 * Delta save. args = { baseRev, meta?, upserts: [entry], deletes: [id] }.
 *  - Entry changes are keyed by id, so they merge across devices.
 *  - Settings/people (meta) are last-write-wins, so they are refused when baseRev is stale.
 *  - A stale baseRev on an entries-only save succeeds but returns stale:true so the page reloads.
 */
function save_(authUser, a) {
  const upserts = Array.isArray(a.upserts) ? a.upserts : [];
  const deletes = Array.isArray(a.deletes) ? a.deletes.map(String) : [];
  if (upserts.length + deletes.length > 20000) throw err_('TOO_BIG', 'Too many changes in one save.');
  return withLock_(function () {
    const user = findUserById_(authUser.userId);
    if (!user || user.active !== 'yes') throw err_('AUTH', 'Please sign in.');
    const stale = Number(a.baseRev) !== Number(user.rev);
    if (a.meta !== undefined && stale) {
      return { ok: false, code: 'CONFLICT', msg: 'This ledger was changed on another device.' };
    }
    if (a.meta !== undefined) {
      if (!a.meta || typeof a.meta !== 'object' || Array.isArray(a.meta)) throw err_('INVALID', 'Bad settings payload.');
      delete a.meta.entries;
      writeMeta_(user.userId, a.meta);
    }
    if (upserts.length || deletes.length) applyEntryChanges_(user, upserts, deletes);
    const rev = Number(user.rev) + 1;
    setUserFields_(user.userId, { rev: rev });
    return { ok: true, data: { rev: rev, stale: stale } };
  });
}

function applyEntryChanges_(user, upserts, deletes) {
  const sh = ledgerSheet_(user.userId);
  const rows = readEntryRows_(sh);
  const index = {};
  rows.forEach(function (r, i) { index[r[0]] = i; });
  const trash = [];
  let rewrite = false;
  const appended = [];
  let owned = null;                                    // lazily listed: ids of files inside this user's folder
  const ownedIds = function () {
    if (!owned) owned = listFolderFileIds_(user.folderId);
    return owned;
  };

  deletes.forEach(function (id) {
    if (!(id in index)) return;
    trash.push.apply(trash, attIds_(rows[index[id]][1]));
    rows[index[id]] = null;
    delete index[id];
    rewrite = true;
  });

  upserts.forEach(function (raw) {
    const e = sanitizeEntry_(raw, ownedIds);
    const json = JSON.stringify(e);
    if (json.length > CFG.MAX_ENTRY_JSON) throw err_('TOO_BIG', 'An entry is too large.');
    if (e.id in index) {
      const row = rows[index[e.id]];
      const keepIds = (e.att || []).map(function (x) { return x.fileId; });
      attIds_(row[1]).forEach(function (fid) { if (keepIds.indexOf(fid) < 0) trash.push(fid); });
      row[1] = json;
      rewrite = true;
    } else {
      const row = [e.id, json];
      rows.push(row);
      index[e.id] = rows.length - 1;
      appended.push(row);
    }
  });

  if (rewrite) {
    const live = rows.filter(Boolean);
    const last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, 2).clearContent();
    writeRows_(sh, 2, live, 2);
  } else {
    writeRows_(sh, sh.getLastRow() + 1, appended, 2);
  }
  trash.forEach(function (fid) {
    try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) { console.warn('trash failed ' + fid); }
  });
}

function attIds_(json) {
  try {
    return (JSON.parse(json).att || []).map(function (x) { return x.fileId; }).filter(Boolean);
  } catch (e) { return []; }
}

function sanitizeEntry_(raw, ownedIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err_('INVALID', 'Bad entry.');
  const e = JSON.parse(JSON.stringify(raw));
  if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(e.id)) throw err_('INVALID', 'Bad entry id.');
  if (e.att !== undefined) {
    const list = Array.isArray(e.att) ? e.att : [];
    e.att = list.slice(0, CFG.MAX_ATT_PER_ENTRY).filter(function (x) {
      return x && typeof x.fileId === 'string' && ownedIds()[x.fileId];
    }).map(function (x) {
      return { fileId: x.fileId, name: cleanText_(x.name, 80) || 'file', mime: String(x.mime || ''), size: Number(x.size) || 0 };
    });
    if (!e.att.length) delete e.att;
  }
  return e;
}

// ---------------------------------------------------------------- attachments (Drive)

function listFolderFileIds_(folderId) {
  const ids = {};
  const it = DriveApp.getFolderById(folderId).getFiles();
  while (it.hasNext()) ids[it.next().getId()] = true;
  return ids;
}

function upload_(user, a) {
  const mime = String(a.mime || '');
  if (CFG.ALLOWED_MIME.indexOf(mime) < 0) throw err_('INVALID', 'Only JPEG, PNG, WebP and PDF files are allowed.');
  const b64 = String(a.b64 || '');
  if (!b64 || Math.floor(b64.length * 3 / 4) > CFG.MAX_UPLOAD_BYTES) throw err_('TOO_BIG', 'File is too large (max 6 MB).');
  const name = cleanText_(a.name, 80).replace(/[\\\/]/g, '_') || 'file';
  const bytes = Utilities.base64Decode(b64);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const file = DriveApp.getFolderById(user.folderId).createFile(Utilities.newBlob(bytes, mime, stamp + '_' + name));
  return { fileId: file.getId(), name: name, mime: mime, size: bytes.length };
}

function getFile_(user, a) {
  const fileId = String(a.fileId || '');
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) throw err_('INVALID', 'Bad file id.');
  let file;
  try { file = DriveApp.getFileById(fileId); } catch (e) { throw err_('NOT_FOUND', 'File not found.'); }
  let inFolder = false;
  const parents = file.getParents();
  while (parents.hasNext()) { if (parents.next().getId() === user.folderId) { inFolder = true; break; } }
  if (!inFolder) throw err_('FORBIDDEN', 'Not your file.');
  const blob = file.getBlob();
  return { name: file.getName(), mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
}

// ---------------------------------------------------------------- utilities

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Not set up: run setup() first.');
  return v;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { invalidateUsers_(); return fn(); } finally { lock.releaseLock(); }
}

function normUsername_(s) { return String(s || '').trim().toLowerCase(); }

/** Plain text only: no control chars, and never a leading =+-@ (spreadsheet formula injection). */
function cleanText_(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function randomString_(n, alphabet) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random());
  let out = '';
  let seed = bytes;
  while (out.length < n) {
    for (let i = 0; i < seed.length && out.length < n; i++) out += alphabet.charAt((seed[i] & 0xff) % alphabet.length);
    seed = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed.concat([out.length]));
  }
  return out;
}

function generatePassword_() {
  return randomString_(10, 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789');
}
