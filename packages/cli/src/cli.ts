#!/usr/bin/env node
/**
 * mailriz-cli — interactive deployment wizard for MailRiz.
 *
 * Commands:
 *   setup    Deploy end-to-end (Worker + D1 + R2 + DNS + Email Routing + Access)
 *   status   Check deployed service health
 *   update   Update the Worker to the latest release (keeps data)
 *   destroy  Tear down everything (with double confirmation)
 */

import { text, select, confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  banner, commandHeader, checkRow, heading, hint, bullet, link, rows,
  blank, spin, TaskList, finished, aborted, accent,
} from './ui';
import {
  verifyToken, listAccounts, listZones,
  listD1, createD1, d1Query,
  listR2Buckets, createR2Bucket,
  enableEmailRouting, createEmailRoutingRule, getEmailRoutingSettings,
} from './cf';

const execFileP = promisify(execFile);
const CONFIG_DIR = join(homedir(), '.mailriz');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const TMP_DIR = join(CONFIG_DIR, '.temp');
const RELEASE_URL = 'https://github.com/rizkirmdhnnn/mailriz/releases/latest/download/mailriz-worker.tar.gz';

interface Config {
  account_id: string;
  zone_id: string;
  zone_name: string;
  worker_name: string;
  dashboard_hostname: string;
  admin_email: string;
  d1_database_id: string;
  r2_raw_bucket: string;
  r2_attachments_bucket: string;
  r2_html_bucket: string;
  auth_mode: 'access' | 'session';
  session_password_hash?: string;
  installed_at: string;
}

function fail(msg: string): never {
  aborted(msg);
  process.exit(1);
}

async function loadConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------- release fetch

async function fetchReleaseAsset(): Promise<{ dir: string; index: string; migrationsDir: string; assetsDir: string }> {
  await mkdir(TMP_DIR, { recursive: true });
  const tarPath = join(TMP_DIR, 'mailriz-worker.tar.gz');
  const res = await fetch(RELEASE_URL);
  if (!res.ok) throw new Error(`Failed to fetch release: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(tarPath, buf);
  // Extract
  await execFileP('tar', ['-xzf', tarPath, '-C', TMP_DIR]);
  const workerDir = join(TMP_DIR, 'worker');
  const index = join(workerDir, 'index.js');
  const migrationsDir = join(workerDir, 'migrations');
  const assetsDir = join(workerDir, 'assets');
  return { dir: workerDir, index, migrationsDir, assetsDir };
}

/**
 * Deploy the worker by generating a wrangler.jsonc in the release dir and
 * running `wrangler deploy` as a child process. This handles the full stack:
 * module bundle + static assets + D1 + R2 + env vars + cron triggers.
 */
async function deployWithWrangler(opts: {
  token: string;
  accountId: string;
  workerName: string;
  releaseDir: string;
  d1Id: string;
  r2Raw: string;
  r2Att: string;
  r2Html: string;
  adminEmail: string;
  dashboardHostname: string;
  authMode: 'access' | 'session';
  sessionHash?: string;
}) {
  const wranglerConfig = {
    name: opts.workerName,
    main: 'index.js',
    compatibility_date: '2026-06-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    assets: { directory: './assets', binding: 'ASSETS' },
    triggers: { crons: ['0 4 * * *'] },
    // A Custom Domain, not a route: Cloudflare creates the DNS record and
    // issues the certificate. A plain workers route matches URLs but creates
    // no DNS, so the hostname would never resolve.
    routes: [{ pattern: opts.dashboardHostname, custom_domain: true }],
    vars: {
      ADMIN_EMAIL: opts.adminEmail,
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
      TRASH_RETENTION_DAYS: '30',
      AUTH_MODE: opts.authMode,
      SESSION_PASSWORD_HASH: opts.sessionHash || '',
      DASHBOARD_HOSTNAME: opts.dashboardHostname,
    },
    d1_databases: [
      { binding: 'DB', database_name: 'mailriz', database_id: opts.d1Id, migrations_dir: 'migrations' },
    ],
    r2_buckets: [
      { binding: 'RAW_BUCKET', bucket_name: opts.r2Raw },
      { binding: 'ATTACHMENTS_BUCKET', bucket_name: opts.r2Att },
      { binding: 'HTML_BUCKET', bucket_name: opts.r2Html },
    ],
  };
  await writeFile(join(opts.releaseDir, 'wrangler.jsonc'), JSON.stringify(wranglerConfig, null, 2));
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: opts.token, CLOUDFLARE_ACCOUNT_ID: opts.accountId };
  // Resolve wrangler from our own node_modules (it's a runtime dependency), so
  // the CLI works from any directory — no global install needed.
  const require = createRequire(import.meta.url);
  const wranglerPkgPath = require.resolve('wrangler/package.json');
  const wranglerBin = join(dirname(wranglerPkgPath), 'bin', 'wrangler.js');
  await execFileP(process.execPath, [wranglerBin, 'deploy'], { cwd: opts.releaseDir, env });
}

// ---------------------------------------------------------------- setup

const SCOPE_ROWS = [
  '1. Account → Workers Scripts     → Edit',
  '2. Account → D1                  → Edit',
  '3. Account → Workers R2 Storage  → Edit',
  '4. Zone    → Workers Routes      → Edit',
  '5. Zone    → Email Routing Rules → Edit',
  '6. Zone    → DNS                 → Edit',
  '7. Zone    → Zone Settings       → Edit',
];

async function cmdSetup() {
  banner();

  // ---- pre-flight, before anything is asked of the user
  commandHeader('preflight');

  let wranglerOk = false;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('wrangler/package.json');
    const bin = join(dirname(pkg), 'bin', 'wrangler.js');
    wranglerOk = existsSync(bin);
  } catch { wranglerOk = false; }
  checkRow(wranglerOk, 'wrangler', wranglerOk ? 'bundled' : 'not found');

  let cfReachable = false;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/');
    cfReachable = r.ok || r.status === 401 || r.status === 403;
  } catch { cfReachable = false; }
  checkRow(cfReachable, 'cloudflare', cfReachable ? 'api reachable' : 'unreachable — check your network');

  const stateExists = existsSync(CONFIG_PATH);
  checkRow(true, 'state', stateExists ? CONFIG_PATH : `will be created at ${CONFIG_PATH}`);

  try {
    const { stdout } = await execFileP('bun', ['--version']);
    const v = stdout.trim();
    const [majorRaw, minorRaw] = v.split('.').map(Number);
    const major = majorRaw ?? 0;
    const minor = minorRaw ?? 0;
    if (major < 1 || (major === 1 && minor < 1)) {
      checkRow(false, 'bun', `${v} — need >= 1.1`);
      fail('Bun >= 1.1 required. Install: curl -fsSL https://bun.sh/install | bash');
    }
    checkRow(true, 'bun', v);
  } catch {
    checkRow(false, 'bun', 'not installed');
    fail('Bun is required. Install: curl -fsSL https://bun.sh/install | bash');
  }

  // ---- token
  heading('Cloudflare API token');
  hint('MailRiz needs a token carrying these 7 scopes:');
  for (const row of SCOPE_ROWS) bullet(row);
  blank();
  hint('Token page (name is pre-filled):');
  const tokenUrl = 'https://dash.cloudflare.com/profile/api-tokens?name=mailriz-cli';
  link(tokenUrl);
  blank();

  const openBrowser = (await confirm({
    message: 'Open that page in your browser now?',
    initialValue: true,
  })) as boolean;
  if (isCancel(openBrowser)) process.exit(0);
  if (openBrowser) await openUrl(tokenUrl);

  const token = (await text({
    message: 'Paste the token',
    placeholder: 'blank = use $CLOUDFLARE_API_TOKEN',
    validate: (v) => {
      if (v && v.length > 20) return undefined;
      return process.env.CLOUDFLARE_API_TOKEN ? undefined : 'Token looks too short';
    },
  })) as string;
  if (isCancel(token)) process.exit(0);
  const effectiveToken = token || process.env.CLOUDFLARE_API_TOKEN || '';

  blank();
  let verified;
  try {
    verified = await spin('token', () => verifyToken(effectiveToken), (v) => `valid · ${v.id}`);
  } catch (e: any) {
    fail(`Token verification failed: ${e.message}`);
  }

  // ---- account + zone
  const accounts = await spin(
    'accounts',
    () => listAccounts(effectiveToken),
    (a) => `${a.length} available`
  );
  if (accounts.length === 0) fail('No accounts on this token');

  let accountId: string;
  let accountObj = accounts[0]!;
  if (accounts.length > 1) {
    blank();
    const chosen = (await select({
      message: 'Which account?',
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    })) as string;
    if (isCancel(chosen)) process.exit(0);
    accountObj = accounts.find((a) => a.id === chosen)!;
    blank();
  }
  accountId = accountObj.id;

  const zones = await spin(
    'zones',
    () => listZones(effectiveToken, accountId),
    (z) => `${z.length} available`
  );
  if (zones.length === 0) fail('No zones on this account — add a domain first');

  let zoneObj = zones[0]!;
  if (zones.length > 1) {
    blank();
    const chosen = (await select({
      message: 'Which domain?',
      options: zones.map((z) => ({ value: z.id, label: `${z.name} (${z.status})` })),
    })) as string;
    if (isCancel(chosen)) process.exit(0);
    zoneObj = zones.find((z) => z.id === chosen)!;
  }
  const zoneId = zoneObj.id;

  // ---- configuration
  heading('Configuration');
  const dashboardHostname = (await text({
    message: 'Dashboard hostname',
    placeholder: `inbox.${zoneObj.name}`,
    initialValue: `inbox.${zoneObj.name}`,
    validate: (v) => (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v || '') ? undefined : 'Invalid hostname'),
  })) as string;
  const adminEmail = (await text({
    message: 'Admin email (single-user access)',
    placeholder: 'you@example.com',
    validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v || '') ? undefined : 'Invalid email'),
  })) as string;

  const useAccess = (await confirm({
    message: 'Use Cloudflare Access for auth? (recommended)',
    initialValue: true,
  })) as boolean;

  let authMode: 'access' | 'session' = 'access';
  let sessionHash: string | undefined;
  if (!useAccess) {
    const pw = (await text({
      message: 'Set a dashboard password (session fallback)',
      placeholder: 'min 8 chars',
      validate: (v) => (v && v.length >= 8 ? undefined : 'min 8 chars'),
    })) as string;
    sessionHash = await sha256(pw);
    authMode = 'session';
  }

  // ---- provisioning: one live task block owns the screen from here on.
  // Nothing interactive may print until tasks.stop(); warnings are queued and
  // shown underneath so long text can't tear the redrawn rows.
  const workerName = 'mailriz';

  blank();
  commandHeader('setup', `${accountObj.name} / ${zoneObj.name}`);

  const tasks = new TaskList([
    { key: 'token', label: 'token' },
    { key: 'account', label: 'account' },
    { key: 'zone', label: 'zone' },
    { key: 'release', label: 'release' },
    { key: 'd1', label: 'd1' },
    { key: 'migrations', label: 'migrations' },
    { key: 'r2', label: 'r2' },
    { key: 'worker', label: 'worker' },
    { key: 'routing', label: 'email routing' },
    { key: 'access', label: 'access' },
    { key: 'health', label: 'health' },
  ]);

  tasks.seed('token', `valid · ${verified.id}`);
  tasks.seed('account', accountObj.name);
  tasks.seed('zone', zoneObj.name);
  if (!useAccess) tasks.seed('access', 'session password', 'skip');
  tasks.start();

  // Annotated on the variable, not just the arrow, so TypeScript treats calls
  // to it as terminating control flow.
  const abort: (msg: string) => never = (msg) => {
    tasks.stop();
    fail(msg);
  };

  // Release artifact.
  tasks.run('release', 'downloading worker bundle…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    tasks.failTask('release', e.message);
    abort(`Release fetch failed: ${e.message}`);
  }
  tasks.ok('release', 'worker bundle ready');

  const migrations = existsSync(release.migrationsDir)
    ? (await readdirSorted(release.migrationsDir))
    : [];

  // D1.
  tasks.run('d1', 'provisioning database…');
  let d1;
  try {
    const d1s = await listD1(effectiveToken, accountId);
    d1 = d1s.find((d) => d.name === 'mailriz');
    if (!d1) d1 = await createD1(effectiveToken, accountId, 'mailriz');
    // A database without a uuid would otherwise flow into the query URL and
    // the wrangler binding as "undefined" and fail much further along.
    if (!d1.uuid) throw new Error('D1 API returned a database without a uuid');
  } catch (e: any) {
    tasks.failTask('d1', e.message);
    abort(`D1 provisioning failed: ${e.message}`);
  }
  tasks.ok('d1', `mailriz (${d1.uuid.slice(0, 8)})`);

  // Migrations.
  tasks.run('migrations', `applying ${migrations.length}…`);
  try {
    for (const m of migrations) {
      const sql = await readFile(join(release.migrationsDir, m), 'utf8');
      await d1Query(effectiveToken, accountId, d1.uuid, sql);
    }
  } catch (e: any) {
    tasks.failTask('migrations', e.message);
    abort(`Migration failed: ${e.message}`);
  }
  tasks.ok('migrations', `${migrations.length} applied`);

  // R2.
  tasks.run('r2', 'creating 3 buckets…');
  let r2Raw, r2Att, r2Html;
  try {
    const r2s = await listR2Buckets(effectiveToken, accountId);
    const ensure = async (name: string) =>
      r2s.find((b) => b.name === name) || await createR2Bucket(effectiveToken, accountId, name);
    r2Raw = await ensure('mailriz-raw');
    r2Att = await ensure('mailriz-attachments');
    r2Html = await ensure('mailriz-html');
  } catch (e: any) {
    tasks.failTask('r2', e.message);
    abort(`R2 provisioning failed: ${e.message}`);
  }
  tasks.ok('r2', 'raw · attachments · html');

  // Worker.
  tasks.run('worker', 'deploying…');
  try {
    await deployWithWrangler({
      token: effectiveToken,
      accountId,
      workerName,
      releaseDir: release.dir,
      d1Id: d1.uuid,
      r2Raw: r2Raw.name,
      r2Att: r2Att.name,
      r2Html: r2Html.name,
      adminEmail,
      dashboardHostname,
      authMode,
      sessionHash,
    });
  } catch (e: any) {
    tasks.failTask('worker', e.message);
    abort(
      `Worker deploy failed: ${e.message}\n` +
      `  If it mentions the custom domain, check that ${dashboardHostname} has no\n` +
      `  existing DNS record — Cloudflare refuses to attach one over a CNAME.`
    );
  }
  // wrangler attaches the Custom Domain as part of the deploy, so reaching
  // here means DNS and the certificate were created too.
  tasks.ok('worker', `${workerName} → ${dashboardHostname}`);

  // Email Routing. Non-fatal, but mail won't arrive until it's on.
  tasks.run('routing', 'enabling catch-all…');
  try {
    const settings = await getEmailRoutingSettings(effectiveToken, zoneId);
    if (!settings.enabled) await enableEmailRouting(effectiveToken, zoneId);
    await createEmailRoutingRule(effectiveToken, zoneId, { type: 'all' }, { type: 'worker', value: [workerName] });
    tasks.ok('routing', `*@${zoneObj.name} → ${workerName}`);
  } catch (e: any) {
    tasks.warn('routing', 'needs manual setup', {
      title: 'Email Routing not configured — mail will not arrive yet',
      body: `${e.message}\n\nEnable it by hand: Email → Email Routing → Enable,\nthen add a catch-all rule pointing at Worker "${workerName}".`,
    });
  }

  // Access, only when the user chose it.
  if (useAccess) {
    tasks.run('access', 'creating application…');
    try {
      await setupAccess(effectiveToken, accountId, dashboardHostname, adminEmail);
      tasks.ok('access', `single-user · ${adminEmail}`);
    } catch (e: any) {
      tasks.warn('access', 'needs manual setup', {
        title: 'Cloudflare Access not configured',
        body:
          `${e.message}\nYour token may be missing Zero Trust permissions.\n\n` +
          `1. Zero Trust → Access → Applications → Add an application\n` +
          `2. Type: Self-hosted. Domain: ${dashboardHostname}\n` +
          `3. Policy: allow only ${adminEmail}\n` +
          `4. Save, then set Worker vars ACCESS_TEAM_DOMAIN and ACCESS_AUD.`,
      });
    }
  }

  // Health.
  tasks.run('health', 'probing /healthz…');
  let healthy = false;
  try {
    const res = await fetch(`https://${dashboardHostname}/healthz`);
    healthy = res.ok;
  } catch {}
  if (healthy) tasks.ok('health', 'responding');
  else tasks.warn('health', 'not reachable yet — DNS may need a minute');

  tasks.stop();

  const cfg: Config = {
    account_id: accountId,
    zone_id: zoneId,
    zone_name: zoneObj.name,
    worker_name: workerName,
    dashboard_hostname: dashboardHostname,
    admin_email: adminEmail,
    d1_database_id: d1.uuid,
    r2_raw_bucket: r2Raw.name,
    r2_attachments_bucket: r2Att.name,
    r2_html_bucket: r2Html.name,
    auth_mode: authMode,
    session_password_hash: sessionHash,
    installed_at: new Date().toISOString(),
  };
  await saveConfig(cfg);

  finished('MailRiz is live', [
    ['dashboard', accent(`https://${dashboardHostname}`)],
    ['inbox', `anything@${zoneObj.name}`],
    ['auth', authMode === 'access' ? `Cloudflare Access · ${adminEmail}` : `password · ${adminEmail}`],
    ['state', `${CONFIG_PATH} (chmod 600)`],
  ], 'Send yourself a mail at any address on the domain — it lands in the dashboard.');
}

/** Open a URL with the platform's opener; silent when there's no GUI. */
async function openUrl(url: string): Promise<void> {
  const opener =
    process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open';
  try {
    await execFileP(opener, [url]);
    hint('  opened — create the token, then paste it below');
  } catch {
    hint(`  could not open a browser — visit the link above`);
  }
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readdirSorted(dir: string): Promise<string[]> {
  return import('node:fs/promises').then((fs) => fs.readdir(dir).then((f) => f.sort()));
}

async function setupAccess(token: string, accountId: string, hostname: string, adminEmail: string) {
  // Minimal: create an Access application + policy via Zero Trust API.
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'mailriz',
      domain: hostname,
      type: 'self_hosted',
      session_duration: '24h',
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message?: string }[]; result?: any };
  if (!res.ok || j?.success === false) {
    throw new Error(j?.errors?.[0]?.message || `HTTP ${res.status}`);
  }
  const appId = j.result?.id as string | undefined;
  if (!appId) throw new Error('Access app was created but returned no id');
  // Policy
  const pres = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps/${appId}/policies`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Only admin',
      decision: 'allow',
      include: [{ email: { email: adminEmail } }],
    }),
  });
  const pj = (await pres.json().catch(() => ({}))) as { success?: boolean; errors?: { message?: string }[]; result?: any };
  if (!pres.ok || pj?.success === false) {
    throw new Error(pj?.errors?.[0]?.message || `HTTP ${pres.status}`);
  }
}

// ---------------------------------------------------------------- status

async function cmdStatus() {
  banner();
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');

  commandHeader('status', cfg.dashboard_hostname);
  rows([
    ['dashboard', `https://${cfg.dashboard_hostname}`],
    ['inbox', `anything@${cfg.zone_name}`],
    ['admin', cfg.admin_email],
    ['auth', cfg.auth_mode === 'access' ? 'Cloudflare Access' : 'session password'],
    ['worker', cfg.worker_name],
    ['d1', cfg.d1_database_id.slice(0, 8)],
    ['installed', new Date(cfg.installed_at).toLocaleString()],
  ]);
  blank();

  try {
    await spin(
      'health',
      async () => {
        const res = await fetch(`https://${cfg.dashboard_hostname}/healthz`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      },
      () => 'responding'
    );
  } catch {
    // spin already printed the failing row.
  }
  blank();
}

// ---------------------------------------------------------------- update

async function cmdUpdate() {
  banner();
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');

  commandHeader('update', cfg.dashboard_hostname);
  hint('Replaces the Worker with the latest release. D1 and R2 data are untouched.');
  blank();

  const token = (await text({
    message: 'Cloudflare API Token',
    placeholder: 'same one you used for setup',
    validate: (v) => (v?.length > 20 ? undefined : 'Too short'),
  })) as string;
  if (isCancel(token)) process.exit(0);

  blank();
  const tasks = new TaskList([
    { key: 'release', label: 'release' },
    { key: 'worker', label: 'worker' },
    { key: 'health', label: 'health' },
  ]);
  tasks.start();

  const abort: (msg: string) => never = (msg) => { tasks.stop(); fail(msg); };

  tasks.run('release', 'downloading latest…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    tasks.failTask('release', e.message);
    abort(`Release fetch failed: ${e.message}`);
  }
  tasks.ok('release', 'worker bundle ready');

  tasks.run('worker', 'redeploying…');
  try {
    await deployWithWrangler({
      token,
      accountId: cfg.account_id,
      workerName: cfg.worker_name,
      releaseDir: release.dir,
      d1Id: cfg.d1_database_id,
      r2Raw: cfg.r2_raw_bucket,
      r2Att: cfg.r2_attachments_bucket,
      r2Html: cfg.r2_html_bucket,
      adminEmail: cfg.admin_email,
      dashboardHostname: cfg.dashboard_hostname,
      authMode: cfg.auth_mode,
      sessionHash: cfg.session_password_hash,
    });
  } catch (e: any) {
    tasks.failTask('worker', e.message);
    abort(`Update failed: ${e.message}`);
  }
  tasks.ok('worker', cfg.worker_name);

  tasks.run('health', 'probing /healthz…');
  let healthy = false;
  try {
    healthy = (await fetch(`https://${cfg.dashboard_hostname}/healthz`)).ok;
  } catch {}
  if (healthy) tasks.ok('health', 'responding');
  else tasks.warn('health', 'not reachable yet');

  tasks.stop();

  finished('Updated', [
    ['dashboard', accent(`https://${cfg.dashboard_hostname}`)],
    ['data', 'preserved — D1 and R2 untouched'],
  ]);
}

// ---------------------------------------------------------------- destroy

async function cmdDestroy() {
  banner();
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed.');

  commandHeader('destroy', cfg.dashboard_hostname);
  console.log(`  ${pc.red(pc.bold('This is irreversible.'))} ${pc.dim('It permanently deletes:')}`);
  blank();
  rows([
    ['worker', cfg.worker_name],
    ['d1', `${cfg.d1_database_id.slice(0, 8)} — every stored email`],
    ['r2', `${cfg.r2_raw_bucket}, ${cfg.r2_attachments_bucket}, ${cfg.r2_html_bucket}`],
    ['state', CONFIG_PATH],
  ]);
  blank();
  hint(`Email Routing rules and the Access application are left in place.`);
  blank();

  // Typing the hostname beats a second yes/no — it can't be muscle-memoried.
  const typed = (await text({
    message: `Type the dashboard hostname to confirm`,
    placeholder: cfg.dashboard_hostname,
  })) as string;
  if (isCancel(typed)) process.exit(0);
  if (typed.trim() !== cfg.dashboard_hostname) {
    aborted('Hostname did not match — nothing was deleted.');
    process.exit(0);
  }

  const token = (await text({
    message: 'Cloudflare API Token',
    validate: (v) => (v?.length > 20 ? undefined : 'Too short'),
  })) as string;
  if (isCancel(token)) process.exit(0);

  blank();
  const del = (url: string) =>
    fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  const api = `https://api.cloudflare.com/client/v4/accounts/${cfg.account_id}`;

  const tasks = new TaskList([
    { key: 'worker', label: 'worker' },
    { key: 'd1', label: 'd1' },
    { key: 'r2', label: 'r2' },
    { key: 'state', label: 'state' },
  ]);
  tasks.start();

  tasks.run('worker', 'deleting…');
  await del(`${api}/workers/scripts/${cfg.worker_name}`);
  tasks.ok('worker', 'deleted');

  tasks.run('d1', 'deleting database…');
  await del(`${api}/d1/database/${cfg.d1_database_id}`);
  tasks.ok('d1', 'deleted');

  tasks.run('r2', 'deleting 3 buckets…');
  for (const b of [cfg.r2_raw_bucket, cfg.r2_attachments_bucket, cfg.r2_html_bucket]) {
    await del(`${api}/r2/buckets/${b}`);
  }
  tasks.ok('r2', 'deleted');

  tasks.run('state', 'removing config…');
  await rm(CONFIG_PATH, { force: true }).catch(() => {});
  tasks.ok('state', 'removed');

  tasks.stop();

  finished('Destroyed', [
    ['left behind', 'Email Routing rules · Access application'],
  ], 'Remove those in the Cloudflare dashboard if you no longer need them.');
}

// ---------------------------------------------------------------- main

const COMMANDS: [string, string][] = [
  ['setup', 'Deploy end-to-end — Worker, D1, R2, DNS, Email Routing, Access'],
  ['status', 'Show the installation and probe the Worker'],
  ['update', 'Move the Worker to the latest release, keeping all data'],
  ['destroy', 'Delete the Worker, database, and stored mail'],
];

function cmdHelp(unknown?: string): void {
  banner();
  if (unknown) {
    aborted(`Unknown command: ${unknown}`);
  }
  commandHeader('commands');
  rows(COMMANDS.map(([name, desc]) => [name, pc.dim(desc)]));
  blank();
  hint('Run without a command to start setup. Config lives in ~/.mailriz/config.json.');
  blank();
}

const cmd = process.argv[2] || 'setup';

if (cmd === 'setup') cmdSetup();
else if (cmd === 'status') cmdStatus();
else if (cmd === 'update') cmdUpdate();
else if (cmd === 'destroy') cmdDestroy();
else if (['help', '--help', '-h'].includes(cmd)) cmdHelp();
else {
  cmdHelp(cmd);
  process.exit(1);
}
