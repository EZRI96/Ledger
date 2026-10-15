const assert = require('assert');
const { loadServer } = require('./gas-mock');
const g = loadServer();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const R = (m, tok, a) => JSON.parse(JSON.stringify(g.rpc(m, tok, a)));

g.setup();
const pwLine = g.__log[0].slice(1)[1];

t('setup creates admin and refuses a second run', () => {
  assert.ok(pwLine && pwLine.length === 10);
  assert.throws(() => g.setup(), /Already set up/);
});

let admin;
t('admin can sign in; wrong password and unknown user fail identically', () => {
  const r = R('login', '', { username: 'Admin ', password: pwLine });
  assert.ok(r.ok, JSON.stringify(r)); admin = r.data;
  assert.strictEqual(R('login', '', { username: 'admin', password: 'nope' }).msg, 'Wrong username or password.');
  assert.strictEqual(R('login', '', { username: 'ghost', password: 'nope' }).msg, 'Wrong username or password.');
});

t('lockout after 5 failures, even with the right password', () => {
  for (let i = 0; i < 5; i++) R('login', '', { username: 'admin', password: 'x' + i });
  assert.strictEqual(R('login', '', { username: 'admin', password: pwLine }).code, 'LOCKED');
  delete g.__cache['fail:admin'];
});

t('token is tamper-proof and requires auth', () => {
  assert.strictEqual(R('load', '', {}).code, 'AUTH');
  assert.strictEqual(R('load', admin.token.slice(0, -2) + 'AA', {}).code, 'AUTH');
  const [id, exp, ver, sig] = admin.token.split('.');
  assert.strictEqual(R('load', [id, Number(exp) + 1e9, ver, sig].join('.'), {}).code, 'AUTH');
  assert.ok(R('load', admin.token, {}).ok);
});

let alice, bob;
t('only admin manages users; created user gets a password and own folder/sheet', () => {
  const c = R('createUser', admin.token, { username: 'Alice', name: '=HYPERLINK("x")' });
  assert.ok(c.ok, JSON.stringify(c));
  assert.strictEqual(c.data.user.name, 'HYPERLINK("x")');           // formula prefix stripped
  assert.strictEqual(R('createUser', admin.token, { username: 'alice', name: 'x' }).code, 'EXISTS');
  assert.strictEqual(R('createUser', admin.token, { username: 'a b', name: 'x' }).code, 'INVALID');
  alice = R('login', '', { username: 'alice', password: c.data.password }).data;
  const b = R('createUser', admin.token, { username: 'bob', name: 'Bob' });
  bob = R('login', '', { username: 'bob', password: b.data.password }).data;
  assert.strictEqual(R('listUsers', alice.token, {}).code, 'FORBIDDEN');
  assert.strictEqual(R('createUser', alice.token, { username: 'eve', name: 'x' }).code, 'FORBIDDEN');
  assert.strictEqual(R('listUsers', admin.token, {}).data.length, 3);
});

const E = (id, extra) => Object.assign({ id, day: '2026-01-05', ts: 1, type: 'out', amt: 5000, tag: 'Food', acct: 'Cash', bucket: 'personal', note: '' }, extra);

t('new user loads empty; save appends, ids merge, rev increments', () => {
  const l = R('load', alice.token, {}).data;
  assert.deepStrictEqual(l.doc, { entries: [] }); assert.strictEqual(l.rev, 0);
  let s = R('save', alice.token, { baseRev: 0, meta: { setup: { floor: 100 }, people: [], zero: ['2026-01-01'] }, upserts: [E('a1'), E('a2')], deletes: [] });
  assert.ok(s.ok, JSON.stringify(s)); assert.strictEqual(s.data.rev, 1);
  s = R('save', alice.token, { baseRev: 1, upserts: [E('a2', { amt: 7000 }), E('a3')], deletes: ['a1'] });
  assert.ok(s.ok); assert.strictEqual(s.data.rev, 2);
  const d = R('load', alice.token, {}).data.doc;
  assert.deepStrictEqual(d.entries.map((e) => [e.id, e.amt]), [['a2', 7000], ['a3', 5000]]);
  assert.deepStrictEqual(d.setup, { floor: 100 }); assert.deepStrictEqual(d.zero, ['2026-01-01']);
});

t('stale meta write is refused; stale entries-only write merges and flags stale', () => {
  const c = R('save', alice.token, { baseRev: 0, meta: { setup: { floor: 1 } } });
  assert.strictEqual(c.code, 'CONFLICT');
  const s = R('save', alice.token, { baseRev: 0, upserts: [E('a9')] });
  assert.ok(s.ok && s.data.stale === true);
  assert.strictEqual(R('load', alice.token, {}).data.doc.setup.floor, 100);
  assert.ok(R('load', alice.token, {}).data.doc.entries.some((e) => e.id === 'a9'));
});

t('users cannot see each other\'s data', () => {
  const b = R('load', bob.token, {}).data.doc;
  assert.deepStrictEqual(b, { entries: [] });
});

t('large meta is chunked across cells and survives a round trip', () => {
  const zero = Array.from({ length: 12000 }, (_, i) => '2026-01-' + String(i).padStart(5, '0'));
  const rev = R('load', alice.token, {}).data.rev;
  assert.ok(R('save', alice.token, { baseRev: rev, meta: { setup: { floor: 100 }, people: [], zero } }).ok);
  const d = R('load', alice.token, {}).data.doc;
  assert.strictEqual(d.zero.length, 12000);
  assert.ok(g.__sheets[g.__store.SHEET_ID].getSheetByName('Meta').getLastRow() > 3);
});

t('more than 1000 entries grow the sheet (setValues would otherwise throw)', () => {
  const rev = R('load', bob.token, {}).data.rev;
  const many = Array.from({ length: 2500 }, (_, i) => E('b' + i));
  const s = R('save', bob.token, { baseRev: rev, upserts: many });
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(R('load', bob.token, {}).data.doc.entries.length, 2500);
  const s2 = R('save', bob.token, { baseRev: s.data.rev, upserts: [E('b7', { amt: 1 })], deletes: ['b8'] });
  assert.ok(s2.ok);
  const e = R('load', bob.token, {}).data.doc.entries;
  assert.strictEqual(e.length, 2499); assert.strictEqual(e.find((x) => x.id === 'b7').amt, 1);
});

t('rejects bad entry ids and oversize entries', () => {
  const rev = R('load', alice.token, {}).data.rev;
  assert.strictEqual(R('save', alice.token, { baseRev: rev, upserts: [{ id: '../x' }] }).code, 'INVALID');
  assert.strictEqual(R('save', alice.token, { baseRev: rev, upserts: [E('big', { note: 'x'.repeat(9000) })] }).code, 'TOO_BIG');
});

const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
let att;
t('upload stores in the user\'s own folder; type and size are enforced', () => {
  const u = R('upload', alice.token, { name: '../r.png', mime: 'image/png', b64: png });
  assert.ok(u.ok, JSON.stringify(u)); att = u.data;
  assert.strictEqual(att.name, '.._r.png');
  assert.strictEqual(R('upload', alice.token, { name: 'x.exe', mime: 'application/x-msdownload', b64: png }).code, 'INVALID');
  assert.strictEqual(R('upload', alice.token, { name: 'x.png', mime: 'image/png', b64: 'A'.repeat(9 * 1024 * 1024) }).code, 'TOO_BIG');
});

t('attachment can be attached to an entry, read back by owner, never by another user', () => {
  const rev = R('load', alice.token, {}).data.rev;
  assert.ok(R('save', alice.token, { baseRev: rev, upserts: [E('a5', { att: [{ fileId: att.fileId, name: att.name, mime: att.mime, size: att.size }] })] }).ok);
  const f = R('file', alice.token, { fileId: att.fileId });
  assert.ok(f.ok && f.data.b64 === png && f.data.mime === 'image/png');
  assert.strictEqual(R('file', bob.token, { fileId: att.fileId }).code, 'FORBIDDEN');
  assert.strictEqual(R('file', bob.token, { fileId: 'nope' }).code, 'INVALID');
});

t('fake / foreign attachment ids on an entry are dropped', () => {
  const rev = R('load', bob.token, {}).data.rev;
  R('save', bob.token, { baseRev: rev, upserts: [E('bx', { att: [{ fileId: att.fileId, name: 'stolen' }, { fileId: 'madeup', name: 'x' }] })] });
  const e = R('load', bob.token, {}).data.doc.entries.find((x) => x.id === 'bx');
  assert.strictEqual(e.att, undefined);
});

t('removing an attachment or deleting its entry trashes the Drive file', () => {
  const u2 = R('upload', alice.token, { name: 'b.png', mime: 'image/png', b64: png }).data;
  let rev = R('load', alice.token, {}).data.rev;
  assert.ok(R('save', alice.token, { baseRev: rev, upserts: [E('a6', { att: [u2] })] }).ok);
  rev++;
  assert.ok(R('save', alice.token, { baseRev: rev, upserts: [E('a5')] }).ok);     // a5 loses its attachment
  assert.strictEqual(g.__files[att.fileId].trashed, true);
  rev++;
  assert.ok(R('save', alice.token, { baseRev: rev, deletes: ['a6'] }).ok);
  assert.strictEqual(g.__files[u2.fileId].trashed, true);
});

t('password change signs out other sessions; reset and disable work', () => {
  const cp = R('changePassword', alice.token, { current: 'wrong', next: 'newpassword1' });
  assert.strictEqual(cp.code, 'BAD_LOGIN');
  assert.strictEqual(R('changePassword', alice.token, { current: 'x', next: 'short' }).code, 'WEAK');
  const pw = R('resetPassword', admin.token, { userId: bob.user.id }).data.password;
  assert.strictEqual(R('load', bob.token, {}).code, 'AUTH');                       // old session dead
  const b2 = R('login', '', { username: 'bob', password: pw });
  assert.ok(b2.ok);
  assert.ok(R('setActive', admin.token, { userId: bob.user.id, active: false }).ok);
  assert.strictEqual(R('load', b2.data.token, {}).code, 'AUTH');
  assert.strictEqual(R('login', '', { username: 'bob', password: pw }).code, 'BAD_LOGIN');
  assert.strictEqual(R('setActive', admin.token, { userId: admin.user.id, active: false }).code, 'INVALID');
});

t('doGet() renders without throwing and sets the meta tags Apps Script actually allows', () => {
  const out = g.doGet();
  assert.ok(out.getContent().includes('Birr Ledger'));
  assert.deepStrictEqual(out._metas, { viewport: 'width=device-width, initial-scale=1, viewport-fit=cover', 'mobile-web-app-capable': 'yes', 'apple-mobile-web-app-capable': 'yes' });
  assert.strictEqual(out._title, 'Birr Ledger');
});

t('backup trigger/nightly copy run', () => { g.installBackupTrigger(); g.nightlyBackup(); });

t('admin can read any user\'s ledger read-only; audit log records it; users cannot', () => {
  const rev = R('load', alice.token, {}).data.rev;
  assert.ok(R('save', alice.token, { baseRev: rev, upserts: [E('secret1', { tag: 'Rent', amt: 999900 })] }).ok);
  const view = R('adminLoad', admin.token, { userId: alice.user.id });
  assert.ok(view.ok, JSON.stringify(view));
  assert.ok(view.data.doc.entries.some((e) => e.id === 'secret1' && e.amt === 999900));
  assert.strictEqual(view.data.user.username, 'alice');
  assert.strictEqual(R('adminLoad', alice.token, { userId: bob.user.id }).code, 'FORBIDDEN');
  assert.strictEqual(R('adminLoad', alice.token, { userId: admin.user.id }).code, 'FORBIDDEN');
  assert.strictEqual(R('adminLoad', admin.token, { userId: 'ghost' }).code, 'NOT_FOUND');
  const log = R('listAudit', admin.token, {}).data;
  assert.ok(log.some((r) => r.admin === 'admin' && r.target === 'alice' && r.action === 'viewed ledger'));
  assert.strictEqual(R('listAudit', alice.token, {}).code, 'FORBIDDEN');
});

t('adminLoad is read-only: there is no server path for an admin to write another user\'s entries', () => {
  assert.strictEqual(typeof g.rpc, 'function');
  g.rpc('save', admin.token, { baseRev: 0, upserts: [{ id: 'hack' }] });
  // admin's own save only ever touches admin's own ledger sheet, never alice's
  const alice_after = JSON.parse(JSON.stringify(g.rpc('load', alice.token, {}))).data.doc.entries;
  assert.ok(!alice_after.some((e) => e.id === 'hack'));
});

t('admin actions (create/reset/disable) are themselves audited', () => {
  const log = R('listAudit', admin.token, {}).data;
  assert.ok(log.some((r) => r.action === 'created user' && r.target === 'bob'));
  assert.ok(log.some((r) => r.action === 'reset password'));
  assert.ok(log.some((r) => r.action === 'disabled user' || r.action === 'enabled user'));
});

console.log('\n' + n + ' server tests passed');
