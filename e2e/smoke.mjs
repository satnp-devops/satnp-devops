// Browser smoke test: signs in as several seeded people and walks through every screen.
//
//   1. npm run db:reset && npm run build && npm start      (API, worker and web)
//   2. npm i --no-save playwright && npx playwright install chromium   (once)
//   3. node e2e/smoke.mjs
//
// It creates records with a unique suffix, so it can run repeatedly. Screenshots land in e2e/shots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { base32Decode, totp } from '../apps/api/src/lib/totp.js';

// require() also finds a globally installed Playwright (NODE_PATH); import would not.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = process.env.SEED_PASSWORD ?? 'Phoenix@12345';
const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);

const problems = [];
let step = 'start';
const log = (...args) => console.log(`[${step}]`, ...args);

function watch(page, label) {
  page.on('console', (msg) => {
    // Chrome logs expected 401s (checking for a session, wrong password) as console errors.
    if (msg.type() === 'error' && /status of 4\d\d/.test(msg.text())) return;
    if (msg.type() === 'error') problems.push(`${label} console error during "${step}": ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`${label} page error during "${step}": ${err.message}`));
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/v1/') && res.status() >= 500) problems.push(`${label} ${res.status()} ${url}`);
  });
}

/** Poll until read() returns what check() accepts, or the timeout passes; returns the last value. */
async function settle(read, check, timeout = 10_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (check(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
}

async function signIn(page, email, next = '/') {
  await page.goto(`${BASE}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const browser = await chromium.launch();
try {
  // ---------- Owner ----------
  const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const owner = await ownerCtx.newPage();
  watch(owner, 'owner');

  step = 'redirect to sign-in';
  await owner.goto(`${BASE}/settings/people`);
  await owner.waitForURL(/\/login\?next=%2Fsettings%2Fpeople/);
  await shot(owner, '01-login');

  step = 'wrong password';
  await owner.getByLabel('Email').fill('owner@phoenix.test');
  await owner.getByLabel('Password').fill('wrong-password');
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.getByText('Email or password is incorrect').waitFor();

  step = 'owner signs in and returns to people';
  await owner.getByLabel('Password').fill(PASSWORD);
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.waitForURL(`${BASE}/settings/people`);
  await owner.getByRole('cell', { name: /Ritika Sharma/ }).waitFor();
  await shot(owner, '02-people');

  step = 'home';
  await owner.getByRole('link', { name: 'Home' }).click();
  await owner.waitForURL(`${BASE}/`);
  await owner.getByRole('heading', { name: /Good (morning|afternoon|evening), Anand/ }).waitFor();
  await owner.getByText('Recent activity').waitFor();
  await shot(owner, '03-home');

  step = 'organisation: add a team under Pune centre';
  await owner.goto(`${BASE}/settings/organization`);
  await owner.getByRole('button', { name: 'Pune centre' }).first().click();
  await owner.getByRole('heading', { name: 'Pune centre', level: 2, exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Add unit' }).click();
  const unitDialog = owner.getByRole('dialog');
  await unitDialog.getByLabel('Kind of unit').selectOption('team');
  await unitDialog.getByLabel('Name').fill(`Weekend batch ${RUN}`);
  const code = await unitDialog.getByLabel('Code').inputValue();
  if (!code.startsWith('weekend-batch-')) problems.push(`code was not generated from the name: "${code}"`);
  await unitDialog.getByLabel('Function').selectOption('admissions');
  await shot(owner, '04-add-unit');
  await unitDialog.getByRole('button', { name: 'Add unit' }).click();
  await owner.getByRole('heading', { name: `Weekend batch ${RUN}`, level: 2, exact: true }).waitFor();
  await owner.getByRole('button', { name: `Weekend batch ${RUN}` }).first().waitFor();

  step = 'organisation: invalid GSTIN is rejected next to the field';
  await owner.getByRole('button', { name: 'SatnPaper' }).first().click();
  await owner.getByRole('button', { name: 'Edit' }).click();
  await owner.getByRole('dialog').getByLabel('GSTIN').fill('NOT-A-GSTIN');
  await owner.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await owner.getByRole('dialog').getByText('Enter a valid 15-character GSTIN').waitFor();
  await shot(owner, '05-edit-company-error');
  await owner.getByRole('dialog').getByLabel('GSTIN').fill('27ABCDE1234F1Z5');
  await owner.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  await owner.getByText('27ABCDE1234F1Z5').waitFor();
  await shot(owner, '06-organisation');

  step = 'people: invite someone to the new team';
  await owner.goto(`${BASE}/settings/people`);
  await owner.getByRole('button', { name: 'Invite people' }).click();
  const invite = owner.getByRole('dialog');
  await invite.getByLabel('Work email').fill(`asha.${RUN}@phoenix.test`);
  await invite.getByLabel('Name').fill('Asha Verma');
  await invite.getByLabel('Role').selectOption({ label: 'Counsellor' });
  const unitOption = await invite.getByLabel('At').locator('option', { hasText: `Weekend batch ${RUN}` }).getAttribute('value');
  await invite.getByLabel('At').selectOption(unitOption);
  await shot(owner, '07-invite');
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await invite.getByText(`Invitation sent to asha.${RUN}@phoenix.test`).waitFor();
  const inviteUrl = await invite.getByLabel('Invitation link').inputValue();
  log('invite url', inviteUrl.slice(0, 60) + '…');
  await invite.getByRole('button', { name: 'Done' }).click();
  await owner.getByRole('cell', { name: new RegExp(`asha\\.${RUN}`) }).waitFor();

  step = 'people: search and open a person';
  await owner.getByLabel('Search people').fill('ritika');
  const rows = owner.locator('tbody tr');
  const rowCount = await settle(() => rows.count(), (count) => count === 1);
  if (rowCount !== 1) problems.push(`search for ritika showed ${rowCount} rows`);
  await owner.getByRole('button', { name: 'Ritika Sharma' }).click();
  await owner.getByRole('dialog').getByText('Counsellor').first().waitFor();
  await shot(owner, '08-person');
  await owner.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

  step = 'general settings: override and reset currency';
  await owner.goto(`${BASE}/settings/general`);
  const currency = owner.getByLabel('Default currency');
  await currency.selectOption('USD');
  await owner.locator('.setting-row', { hasText: 'Default currency' }).getByRole('button', { name: 'Save' }).click();
  await owner.getByText('Set on Phoenix Educational Institute').first().waitFor();
  await shot(owner, '09-general');
  await owner.locator('.setting-row', { hasText: 'Default currency' }).getByRole('button', { name: 'Use the default' }).click();
  if ((await settle(() => currency.inputValue(), (value) => value === 'INR')) !== 'INR') problems.push('currency did not go back to INR after reset');

  step = 'roles: duplicate a built-in role, then delete the copy';
  await owner.goto(`${BASE}/settings/roles`);
  await owner.getByRole('button', { name: /^Counsellor/ }).click();
  await owner.getByRole('button', { name: 'Duplicate' }).click();
  await owner.getByRole('dialog').getByLabel('Name', { exact: true }).fill(`Senior counsellor ${RUN}`);
  await owner.getByRole('dialog').getByLabel(/See people/).check();
  await owner.getByRole('dialog').getByRole('button', { name: 'Create role' }).click();
  await owner.getByRole('heading', { name: `Senior counsellor ${RUN}`, exact: true }).waitFor();
  await shot(owner, '10-roles');
  await owner.getByRole('button', { name: 'Delete' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Delete role' }).click();
  await owner.getByRole('heading', { name: `Senior counsellor ${RUN}`, exact: true }).waitFor({ state: 'detached' });

  step = 'audit log';
  await owner.goto(`${BASE}/settings/audit`);
  await owner.getByText('Added a unit').first().waitFor();
  await owner.getByRole('button', { name: 'Details' }).first().click();
  await shot(owner, '11-audit');

  // ---------- The invited person ----------
  step = 'accept the invitation';
  const ashaCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const asha = await ashaCtx.newPage();
  watch(asha, 'asha');
  await asha.goto(inviteUrl);
  await asha.getByText('Anand Rao invited').waitFor();
  await shot(asha, '12-accept-invite');
  await asha.getByLabel('Password', { exact: true }).fill('a-long-password-2026');
  await asha.getByLabel('Confirm password').fill('a-long-password-2026');
  await asha.getByRole('button', { name: 'Create my account' }).click();
  await asha.waitForURL(`${BASE}/`);
  await asha.getByRole('heading', { name: /Asha/ }).waitFor();

  step = 'counsellor cannot open people';
  await asha.goto(`${BASE}/settings/people`);
  await asha.getByText("You don't have access to this here").waitFor();
  const tabs = await asha.getByRole('navigation', { name: 'Settings sections' }).getByRole('link').allTextContents();
  log('tabs for a counsellor', tabs.join(', '));
  if (tabs.includes('People')) problems.push('counsellor sees the People tab');

  step = 'set up two-step verification';
  await asha.goto(`${BASE}/settings/security`);
  await asha.getByRole('button', { name: 'Set up two-step verification' }).click();
  const secret = (await asha.locator('code.secret').textContent()).replace(/\s/g, '');
  await asha.getByLabel('Code from the app').fill(totp(base32Decode(secret)));
  await shot(asha, '13-mfa-scan');
  await asha.getByRole('button', { name: 'Turn on' }).click();
  await asha.getByText('Two-step verification is on').waitFor();
  const recovery = (await asha.locator('ul.code-block li').first().textContent()).trim();
  await shot(asha, '14-recovery-codes');
  await asha.getByRole('button', { name: "I've saved them" }).click();
  await asha.getByRole('button', { name: 'Turn off' }).waitFor();

  step = 'sign out and back in with a recovery code';
  await asha.getByRole('button', { name: 'Sign out' }).click();
  await asha.waitForURL(/\/login/);
  await asha.getByLabel('Email').fill(`asha.${RUN}@phoenix.test`);
  await asha.getByLabel('Password').fill('a-long-password-2026');
  await asha.getByRole('button', { name: 'Sign in' }).click();
  await asha.getByRole('heading', { name: 'Two-step verification' }).waitFor();
  await shot(asha, '15-code-step');
  await asha.getByRole('button', { name: 'Use a recovery code' }).click();
  await asha.getByLabel('Recovery code').fill(recovery);
  await asha.getByRole('button', { name: 'Verify' }).click();
  await asha.waitForURL(`${BASE}/`);

  // ---------- Company admin ----------
  step = 'company admin sees only their company';
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const admin = await adminCtx.newPage();
  watch(admin, 'company admin');
  await signIn(admin, 'admin.satnpaper@phoenix.test', '/settings/organization');
  await admin.waitForURL(`${BASE}/settings/organization`);
  const groupButton = admin.getByRole('button', { name: 'Phoenix Educational Institute' });
  if (!(await groupButton.isDisabled())) problems.push('group should be shown for context only');
  if ((await admin.getByRole('button', { name: 'Pi Vector' }).count()) > 0) problems.push('company admin sees another company');
  if ((await admin.getByRole('button', { name: 'Archive' }).count()) > 0) problems.push('company admin can archive their own company');
  const scopeOptions = await admin.getByLabel('Working in').locator('option').allTextContents();
  log('scope options', scopeOptions.map((o) => o.trim()).join(' | '));
  await shot(admin, '16-company-admin-org');

  step = 'company admin requires 2FA for SatnPaper';
  await admin.goto(`${BASE}/settings/general`);
  await admin.getByText('Require two-step verification').waitFor();
  await admin.locator('.setting-row', { hasText: 'Require two-step verification' }).getByRole('checkbox').check();
  await admin.locator('.setting-row', { hasText: 'Require two-step verification' }).getByRole('button', { name: 'Save' }).click();
  // The admin has no 2FA yet, so the app now sends them to set it up.
  await admin.waitForURL(`${BASE}/settings/security`, { timeout: 15000 });
  await admin.getByText('Set up two-step verification to continue').waitFor();
  await shot(admin, '17-mfa-required');
  await admin.getByRole('link', { name: 'Home' }).count().then((n) => {
    if (n > 0) problems.push('nav links should be locked while 2FA setup is required');
  });

  step = 'owner turns the requirement off again';
  await owner.goto(`${BASE}/settings/general`);
  const satnpaper = await owner.getByLabel('Working in').locator('option', { hasText: 'SatnPaper' }).first().getAttribute('value');
  await owner.getByLabel('Working in').selectOption(satnpaper);
  const policyRow = owner.locator('.setting-row', { hasText: 'Require two-step verification' });
  await policyRow.getByText('Set on SatnPaper').waitFor();
  await policyRow.getByRole('button', { name: 'Use the value from above' }).click();
  await policyRow.getByText('Default').waitFor();

  step = 'mobile layout';
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mobile = await phone.newPage();
  watch(mobile, 'mobile');
  await signIn(mobile, 'kabir@phoenix.test', '/');
  await mobile.waitForURL(`${BASE}/`);
  await mobile.getByRole('heading', { name: /Kabir/ }).waitFor();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`mobile home scrolls sideways by ${overflow}px`);
  await shot(mobile, '18-mobile-home');
  await mobile.goto(`${BASE}/settings/people`);
  await mobile.getByRole('cell', { name: /Ritika Sharma/ }).waitFor();
  await shot(mobile, '19-mobile-people');
} catch (error) {
  problems.push(`FAILED at "${step}": ${error.message.slice(0, 900)}`);
} finally {
  await browser.close();
}

console.log(problems.length ? `\nProblems:\n- ${problems.join('\n- ')}` : '\nNo problems found');
process.exit(problems.length ? 1 : 0);
