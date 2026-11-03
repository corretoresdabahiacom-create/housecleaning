// Browser end-to-end tests: real UI (built bundle) + real Worker on workerd + local D1 + Durable Object.
// Run: npm run test:e2e   (starts its own wrangler dev on a temporary database)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
// Playwright is resolved from the project or a global install (see README: npm i -D playwright; npx playwright install chromium).
const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), 'hcm-e2e-'));
let server, browser;
const sh = (cmd) => execSync(cmd, { stdio: 'pipe', shell: true }).toString();

function totp(secretB32, offset = 0) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const bytes = [];
  for (const ch of secretB32.replace(/\s/g, '')) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const step = Math.floor(Date.now() / 30000) + offset, msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest(), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

before(async () => {
  if (!existsSync('dist/index.html')) sh('npm run build');
  if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', `ENCRYPTION_KEY=${Buffer.alloc(32, 5).toString('base64')}\nAPP_ENV=development\n`);
  sh(`npx wrangler d1 migrations apply hcm-db --local --persist-to "${persist}"`);
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist], { shell: true, stdio: 'pipe' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 1000)); }
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill('SIGTERM'); try { sh(`pkill -f "wrangler dev --port ${PORT}"`); } catch { /* windows */ } rmSync(persist, { recursive: true, force: true }); });

const email = `owner.${Date.now()}@example.com`, PW = 'E2ePassw0rd!';
const field = (page, label) => page.locator('label.field, div.field').filter({ hasText: label }).first().locator('input, select, textarea').first();

test('register → customer → residence → helper → schedule → complete → finance', async () => {
  const page = await browser.newPage();
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Create a business account' }).click();
  await field(page, "Owner's full name").fill('E2E Owner');
  await field(page, 'Company name').fill('E2E Cleaning');
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(PW);
  await field(page, 'State').selectOption('GA');
  await field(page, 'City').fill('Atlanta');
  await page.getByLabel('I accept the Terms of Service and Privacy Policy').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();

  // customer
  await page.goto(`${BASE}/#/customers`);
  await page.getByRole('button', { name: '+ Add customer' }).click();
  await field(page, 'Full name').fill('Robert Johnson');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name: 'Robert Johnson' }).waitFor();
  // residence (customer preselected; autocomplete shows the name)
  await page.getByRole('button', { name: '+ Add residence' }).click();
  const dlg = page.getByRole('dialog');
  await assert.doesNotReject(dlg.locator('input[role=combobox][value="Robert Johnson"]').waitFor({ timeout: 5000 }));
  await field(dlg, 'Property name').fill('Johnson Residence');
  await field(dlg, 'Street address').fill('12 Peachtree St');
  await field(dlg, 'City').fill('Atlanta');
  await field(dlg, 'State').selectOption('GA');
  await field(dlg, 'ZIP code').fill('30303');
  await field(dlg, 'Cleaning price').fill('180.00');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name: 'Johnson Residence' }).waitFor();

  // helper
  await page.goto(`${BASE}/#/helpers`);
  await page.getByRole('button', { name: '+ Add helper' }).click();
  const h = page.getByRole('dialog');
  await field(h, 'Full name').fill('Maria Silva'); await field(h, 'Main function').fill('Cleaner');
  await field(h, 'State').selectOption('GA'); await field(h, 'City').fill('Atlanta');
  await field(h, 'WhatsApp number').fill('+14045550101'); await field(h, 'Telephone').fill('+14045550101');
  await field(h, 'Preferred language').selectOption('pt'); await field(h, 'Default rate').fill('70');
  await h.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name: 'Maria Silva' }).waitFor();

  // schedule via calendar, picking the property through the autocomplete
  await page.goto(`${BASE}/#/calendar?view=day`);
  await page.getByRole('button', { name: '+ Schedule cleaning' }).click();
  const s = page.getByRole('dialog');
  await s.locator('input[role=combobox]').fill('Johnson');
  await s.getByRole('option', { name: /Johnson Residence/ }).click();
  await s.getByLabel('Maria Silva').check();
  await s.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: /Johnson Residence/ }).first().click();
  await page.getByRole('button', { name: '✓ Mark completed' }).click();
  await page.getByRole('button', { name: 'Confirm completion' }).click();
  await page.getByRole('dialog').getByText('Completed').first().waitFor();

  await page.goto(`${BASE}/#/finance`);
  const net = page.locator('.stat').filter({ hasText: 'Net revenue' }).locator('.stat-v');
  await assert.doesNotReject(net.filter({ hasText: '$180.00' }).waitFor({ timeout: 8000 }));
  const labor = page.locator('.stat').filter({ hasText: 'Helper labor costs' }).locator('.stat-v');
  assert.equal(await labor.textContent(), '$70.00');

  // PDF export downloads a real PDF
  await page.goto(`${BASE}/#/finance/dre`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF', exact: true }).click()]);
  assert.match(dl.suggestedFilename(), /^dre-\d{4}-\d{2}-\d{2}\.pdf$/);
  const [x] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'XLSX', exact: true }).click()]);
  assert.match(x.suggestedFilename(), /\.xlsx$/);
  await page.close();
});

test('language switch translates the interface', async () => {
  const page = await browser.newPage();
  await page.goto(BASE);
  await field(page, 'Email').fill(email); await field(page, 'Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByLabel('Language').selectOption('pt');
  await page.getByRole('heading', { name: 'Painel' }).waitFor();
  await page.getByRole('link', { name: 'Clientes' }).waitFor();
  await page.getByLabel('Idioma').selectOption('es');
  await page.getByRole('heading', { name: 'Panel' }).waitFor();
  await page.getByLabel('Idioma').selectOption('en');
  await page.close();
});

test('real-time chat: helper receives the message without reloading', async () => {
  const owner = await (await browser.newContext()).newPage();
  await owner.goto(BASE);
  await field(owner, 'Email').fill(email); await field(owner, 'Password').fill(PW);
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const helpers = await owner.evaluate(async () => (await (await fetch('/api/helpers')).json()).items);
  const add = await owner.evaluate(async (hid) => (await fetch('/api/members', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hcm' }, body: JSON.stringify({ email: 'maria.e2e@example.com', full_name: 'Maria', role: 'helper', helper_id: hid, temporary_password: 'Helper123!pw' }) })).status, helpers[0].id);
  assert.equal(add, 201);
  const conv = await owner.evaluate(async (hid) => (await (await fetch('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hcm' }, body: JSON.stringify({ helper_id: hid }) })).json()).id, helpers[0].id);

  const helper = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await helper.goto(BASE);
  await field(helper, 'Email').fill('maria.e2e@example.com'); await field(helper, 'Password').fill('Helper123!pw');
  await helper.getByRole('button', { name: 'Sign in' }).click();
  await helper.getByRole('heading', { name: 'Messages' }).waitFor();
  await helper.getByRole('button', { name: /Maria Silva/ }).click();
  await helper.getByText('Live').waitFor({ timeout: 10000 });
  // helper accounts see only Messages
  assert.equal(await helper.locator('nav a', { hasText: 'Customers' }).count(), 0);

  await owner.goto(`${BASE}/#/messages?c=${conv}`);
  await owner.getByText('Live').waitFor({ timeout: 10000 });
  await owner.getByLabel('Message', { exact: true }).fill('Kitchen first today, please');
  await owner.getByRole('button', { name: 'Send', exact: true }).click();
  const t0 = Date.now();
  await helper.locator('.msg').getByText('Kitchen first today, please').waitFor({ timeout: 5000 }); // polling fallback is 60 s while live
  assert.ok(Date.now() - t0 < 5000);
  await owner.close(); await helper.close();
});

test('mobile layout: navigation drawer and no horizontal scroll', async () => {
  const page = await (await browser.newContext({ viewport: { width: 375, height: 740 } })).newPage();
  await page.goto(BASE);
  await field(page, 'Email').fill(email); await field(page, 'Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.locator('nav.side').getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('heading', { name: 'Calendar' }).waitFor();
  for (const p of ['/', '/properties', '/finance', '/finance/dre']) {
    await page.goto(`${BASE}/#${p}`);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal overflow on ${p}: ${overflow}px`);
  }
  await page.close();
});

test('two-step verification: enable in settings, then login requires the code', async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE);
  await field(page, 'Email').fill(email); await field(page, 'Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.goto(`${BASE}/#/settings`);
  await page.getByRole('button', { name: 'Set up' }).click();
  const secret = (await page.locator('.mono').textContent()).replace(/\s/g, '');
  await page.getByLabel('Code').fill(totp(secret));
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByText('Save these recovery codes now').waitFor();
  assert.equal(await page.locator('.codes span').count(), 8);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();

  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await field(page, 'Email').fill(email); await field(page, 'Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Two-step verification' }).waitFor();
  await field(page, 'Code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByText('Invalid verification code.').waitFor();
  await field(page, 'Code').fill(totp(secret, 1)); // next step (the enable step cannot be replayed)
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.close();
});
