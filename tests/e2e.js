// Real browser + real Index.html + real Code.gs (run in a vm with in-memory Sheets/Drive).
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const { loadServer } = require('./gas-mock');

const g = loadServer();
const J = (x) => JSON.parse(JSON.stringify(x));
g.setup();
const adminPw = g.__log[0].slice(1)[1];
const admin = J(g.rpc('login', '', { username: 'admin', password: adminPw })).data;
const mk = (u) => J(g.rpc('createUser', admin.token, { username: u, name: u[0].toUpperCase() + u.slice(1) })).data.password;
const alicePw = mk('alice'), bobPw = mk('bob');
// give alice a configured ledger so the main UI (not the first-run wizard) shows
const al = J(g.rpc('login', '', { username: 'alice', password: alicePw })).data;
J(g.rpc('save', al.token, { baseRev: 0, meta: { setup: { floor: 1500000, bufferMonths: 3, opening: { Cash: 500000, telebirr: 0, Bank: 0 }, envStart: '2026-10-01' }, people: [], zero: [], lastBackup: Date.now() }, upserts: [], deletes: [] }));

const html = fs.readFileSync(path.join(__dirname, '../apps-script/Index.html'), 'utf8');
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const { args } = JSON.parse(b);
      const out = JSON.stringify(g.rpc(...args));
      res.setHeader('content-type', 'application/json'); res.end(out);
    }); return;
  }
  res.setHeader('content-type', 'text/html'); res.end(html);
});

const SHIM = `window.google={script:{run:(function(){function mk(s,f){return new Proxy({},{get:function(t,n){
  if(n==='withSuccessHandler')return function(h){return mk(h,f)};
  if(n==='withFailureHandler')return function(h){return mk(s,h)};
  return function(){var a=Array.prototype.slice.call(arguments);
    fetch('/rpc',{method:'POST',body:JSON.stringify({args:a})}).then(function(r){return r.json()}).then(function(r){s&&s(r)}).catch(function(e){f&&f(e)});}}})}
  return mk(null,null)})()}};`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let n = 0; const ok = (m) => { n++; console.log('  ok  ' + m); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(SHIM);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // (the sandbox proxy cannot fetch Google Fonts, hence the cert filter below)
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  await page.goto(url);
  await page.waitForSelector('#l_go');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/login.png' });
  ok('login screen shown, no data without sign-in');

  await page.fill('#l_u', 'alice'); await page.fill('#l_p', 'wrongpass'); await page.click('#l_go');
  await page.waitForFunction(() => document.getElementById('l_err').textContent.includes('Wrong'));
  ok('wrong password rejected with message');

  await page.fill('#l_p', alicePw); await page.click('#l_go');
  await page.waitForSelector('.nav');
  assert.ok((await page.textContent('.hdrR')).includes('Alice'));
  ok('alice signs in and sees her ledger');

  await page.click('.nav button[data-t="day"]');
  await page.click('#m_out');
  await page.fill('#amt', '250');
  await page.click('[data-tag="Food"]');
  await page.click('[data-acct="Cash"]');
  await page.setInputFiles('#attf', { name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.attc.new');
  await page.setInputFiles('#attf', { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await page.waitForFunction(() => document.body.textContent.includes('use a photo'));
  ok('attachment staged; wrong file type refused client-side');

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/form.png', fullPage: true });
  await page.click('#rec');
  await page.waitForSelector('.row .attb');
  ok('entry recorded with 📎 indicator');

  const rows = J(g.rpc('load', al.token, {})).data.doc.entries;
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].amt, 25000);
  assert.strictEqual(rows[0].att.length, 1); assert.strictEqual(rows[0].att[0].mime, 'image/jpeg');
  const file = g.__files[rows[0].att[0].fileId];
  assert.ok(file && !file.trashed && file.mime === 'image/jpeg');
  ok('server holds the entry; receipt is a JPEG in Drive');

  await page.click('.row .attb');
  await page.waitForSelector('.attimg img');
  await page.waitForFunction(() => { const i = document.querySelector('.attimg img'); return i && i.complete && i.naturalWidth > 0; });
  ok('receipt displays from Drive through the server');
  await page.click('#p_x');

  await page.reload(); await page.waitForSelector('.nav');
  await page.click('.nav button[data-t="day"]');
  await page.waitForSelector('.row .attb');
  ok('reload keeps the session and the data (no browser data storage involved)');

  await page.click('.row .del');
  await page.waitForFunction(() => !document.querySelector('.row .attb'));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(J(g.rpc('load', al.token, {})).data.doc.entries.length, 0);
  assert.strictEqual(file.trashed, true);
  ok('deleting the entry removes it server-side and trashes the Drive file');

  // Restore (migration path): a backup in the OLD format (v4 'debts', no 'day', no ids on people ok)
  const old = { entries: [{ id: 'o1', ts: Date.parse('2026-09-20T10:00:00'), type: 'out', amt: 12000, tag: 'Food', acct: 'Cash' },
                          { id: 'o2', ts: Date.parse('2026-09-21T10:00:00'), type: 'in', amt: 900000, tag: 'Design fee', acct: 'Bank' }],
                debts: [{ id: 'd1', name: 'Kebede', opening: 50000 }], zero: [], setup: { floor: 1500000, bufferMonths: 3, opening: { Cash: 100000 } } };
  await page.click('#imp');
  await page.fill('#rs_text', JSON.stringify(old)); await page.click('#rs_go');
  await page.waitForFunction(() => !document.querySelector('#rs_go'));
  await new Promise((r) => setTimeout(r, 400));
  const after = J(g.rpc('load', al.token, {})).data.doc;
  assert.strictEqual(after.entries.length, 2);
  assert.ok(after.entries.every((e) => /^\d{4}-\d\d-\d\d$/.test(e.day)));
  assert.deepStrictEqual(after.people.map((p) => [p.name, p.opening]), [['Kebede', -50000]]);
  assert.ok(after.setup.envStart);
  ok('restore of an OLD-format backup is migrated and saved to the server');

  // second device sees it; stale-device scenario
  const page2 = await ctx.newPage();
  page2.on('dialog', (d) => d.accept());
  await page2.goto(url); await page2.waitForSelector('.nav');
  await page.click('.nav button[data-t="day"]'); await page.click('#m_out'); await page.fill('#amt', '40');
  await page.click('[data-tag="Coffee"]'); await page.click('[data-acct="Cash"]'); await page.click('#rec');
  await page.waitForFunction(() => document.querySelectorAll('.row').length >= 1);
  await new Promise((r) => setTimeout(r, 300));
  // page2 is now stale; it saves an entry -> must merge, not clobber
  await page2.click('.nav button[data-t="day"]'); await page2.click('#m_out'); await page2.fill('#amt', '60');
  await page2.click('[data-tag="Transport"]'); await page2.click('[data-acct="Cash"]'); await page2.click('#rec');
  await new Promise((r) => setTimeout(r, 600));
  const merged = J(g.rpc('load', al.token, {})).data.doc.entries.map((e) => e.amt).sort((a, b) => a - b);
  assert.deepStrictEqual(merged, [4000, 6000, 12000, 900000]);
  ok('two devices saving concurrently: both entries survive');

  // admin panel + isolation
  const actx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await actx.addInitScript(SHIM);
  const ap = await actx.newPage(); ap.on('dialog', (d) => d.accept());
  ap.on('pageerror', (e) => errors.push(String(e)));
  await ap.goto(url); await ap.fill('#l_u', 'admin'); await ap.fill('#l_p', adminPw); await ap.click('#l_go');
  await ap.waitForSelector('#usr');
  assert.ok(!(await page.$('#usr')));                   // regular user has no Users button
  await ap.click('#usr'); await ap.waitForSelector('.urow');
  await ap.fill('#u_name', 'Carol'); await ap.fill('#u_user', 'carol'); await ap.click('#u_add');
  await ap.waitForSelector('.cred');
  const cred = await ap.textContent('.credv');
  assert.ok(/carol\s*\/\s*\S{10}/.test(cred.replace(/ /g, ' ')), cred);
  assert.strictEqual((await ap.$$('.urow')).length, 4);
  ok('admin creates a user from the app and sees the one-time password');
  assert.strictEqual(J(g.rpc('load', admin.token, {})).data.doc.entries.length, 0);
  ok("admin's own ledger is separate from alice's");

  // --- admin "view as" (read-only), isolation, and audit trail ---
  await ap.click('#p_x');                                     // close Users panel from the earlier block
  await ap.waitForSelector('#usr');
  await ap.click('#usr'); await ap.waitForSelector('.urow');
  const aliceRow = ap.locator('.urow', { hasText: 'alice' });
  await aliceRow.locator('[data-uview]').click();
  await ap.waitForFunction(() => document.getElementById('root').textContent.includes('Read-only'));
  assert.ok(/alice/i.test(await ap.textContent(".alarm")));
  await ap.waitForFunction(() => document.querySelectorAll('.row').length > 0);
  ok("admin opens alice's ledger read-only and sees her real entries");

  assert.strictEqual(await ap.$('#m_in'), null);
  assert.strictEqual(await ap.$('.row .edt'), null);
  assert.strictEqual(await ap.$('.row .del'), null);
  assert.strictEqual(await ap.$('#edit'), null);
  assert.strictEqual(await ap.$('#imp'), null);
  assert.strictEqual(await ap.$('#reset'), null);
  assert.strictEqual(await ap.$('#usr'), null);
  ok('while viewing, every mutating control is gone — no entry, edit, delete, settings or admin action is possible');

  const beforeCount = J(g.rpc('load', al.token, {})).data.doc.entries.length;
  await ap.click('.backAdminBtn');
  await ap.waitForFunction(() => !document.getElementById('root').textContent.includes('Read-only'));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(J(g.rpc('load', al.token, {})).data.doc.entries.length, beforeCount);
  ok("leaving the view changes nothing in alice's ledger");

  assert.strictEqual(J(g.rpc('load', admin.token, {})).data.doc.entries.length, 0);
  ok("back in admin's own ledger, which is still empty and separate from alice's");

  await ap.click('#usr'); await ap.waitForSelector('.urow');
  await ap.click('#u_audit');
  await ap.waitForSelector('.arow');
  const auditText = await ap.textContent('.card');
  assert.ok(/admin.*viewed ledger.*alice|admin.*alice.*viewed ledger/i.test(auditText.replace(/\s+/g, ' ')), auditText);
  ok("the view is recorded in the admin's own audit log");
  await ap.click('#p_x');

  // a non-admin cannot reach adminLoad even if they knew the id
  const rawAlice = J(g.rpc('adminLoad', al.token, { userId: admin.user.id }));
  assert.strictEqual(rawAlice.code, 'FORBIDDEN');
  ok('server refuses a non-admin adminLoad call outright (defense in depth beyond the hidden UI)');

  await page.click('#out'); await page.waitForSelector('#l_go');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('birrledger:token')), null);
  ok('log out clears the token');

  assert.deepStrictEqual(errors, []);
  ok('no JS errors or console errors in any page');
  console.log('\n' + n + ' e2e checks passed');
  await browser.close(); server.close();
})().catch(async (e) => { console.error('\nFAILED:', e); process.exit(1); });
