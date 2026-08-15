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

import { intro, outro, text, select, confirm, spinner, isCancel, cancel, note } from '@clack/prompts';
import pc from 'picocolors';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { showBanner, stepHeader, statusRow } from './banner';
import {
  verifyToken, listAccounts, listZones,
  listD1, createD1, d1Query,
  listR2Buckets, createR2Bucket,
  enableEmailRouting, createEmailRoutingRule, getEmailRoutingSettings,
  createWorkerRoute,
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
  cancel(msg);
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
  showBanner();

  // Pre-flight checks (mirrors cloakmail's opening status rows).
  let wranglerOk = false;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('wrangler/package.json');
    const bin = join(dirname(pkg), 'bin', 'wrangler.js');
    wranglerOk = existsSync(bin);
  } catch { wranglerOk = false; }
  statusRow(wranglerOk, wranglerOk ? 'wrangler found' : 'wrangler NOT found (bundled with this CLI)');

  let cfReachable = false;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/');
    cfReachable = r.ok || r.status === 401 || r.status === 403;
  } catch { cfReachable = false; }
  statusRow(cfReachable, cfReachable ? 'Cloudflare API is reachable' : 'Cloudflare API unreachable (check your network)');

  const stateExists = existsSync(CONFIG_PATH);
  statusRow(true, stateExists
    ? `State file at ${CONFIG_PATH}`
    : `State file will be created at ${CONFIG_PATH}`);

  // 1. Bun version check (minimum).
  try {
    const { stdout } = await execFileP('bun', ['--version']);
    const v = stdout.trim();
    const [majorRaw, minorRaw] = v.split('.').map(Number);
    const major = majorRaw ?? 0;
    const minor = minorRaw ?? 0;
    if (major < 1 || (major === 1 && minor < 1)) {
      fail(`Bun >= 1.1 required, found ${v}. Install: curl -fsSL https://bun.sh/install | bash`);
    }
  } catch {
    fail('Bun is required. Install: curl -fsSL https://bun.sh/install | bash');
  }

  // 2. Token.
  stepHeader('Step 1: Cloudflare API token');
  console.log(pc.dim('MailRiz needs a Cloudflare API token with these 7 scopes:'));
  for (const row of SCOPE_ROWS) {
    console.log(pc.dim(`  ${row}`));
  }
  const tokenUrl = 'https://dash.cloudflare.com/profile/api-tokens?name=mailriz-cli';
  console.log('');
  console.log(pc.dim('Token page (token name pre-filled):'));
  console.log(pc.dim(`  ${tokenUrl}`));

  const openBrowser = (await confirm({
    message: 'Open the Cloudflare token page in your browser now?',
    initialValue: true,
  })) as boolean;
  if (isCancel(openBrowser)) process.exit(0);
  if (openBrowser) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify: p } = await import('node:util');
      await p(execFile)('xdg-open', [tokenUrl]).catch(() => {});
      console.log(pc.dim('  (opened — create the token, then paste it below)'));
    } catch {
      console.log(pc.dim(`  (could not auto-open — visit ${tokenUrl})`));
    }
  }

  const token = (await text({
    message: 'Cloudflare API Token (paste)',
    placeholder: 'Leave blank to use CLOUDFLARE_API_TOKEN env',
    validate: (v) => {
      if (v && v.length > 20) return undefined;
      return process.env.CLOUDFLARE_API_TOKEN ? undefined : 'Token looks too short';
    },
  })) as string;
  if (isCancel(token)) process.exit(0);
  const effectiveToken = token || process.env.CLOUDFLARE_API_TOKEN || '';

  const sp = spinner();
  sp.start('Verifying token…');
  let verified;
  try {
    verified = await verifyToken(effectiveToken);
  } catch (e: any) {
    sp.stop('✗');
    fail(`Token verification failed: ${e.message}`);
  }
  sp.stop(`✓ Token OK (${verified.id})`);

  // 3. Account + zone selection.
  stepHeader('Step 2: Account & domain');
  const accounts = await listAccounts(effectiveToken);
  if (accounts.length === 0) fail('No accounts on this token');
  let accountId: string;
  let accountObj = accounts[0]!;
  if (accounts.length === 1) {
    accountId = accountObj.id;
  } else {
    const chosen = (await select({
      message: 'Select account',
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    })) as string;
    if (isCancel(chosen)) process.exit(0);
    accountId = chosen;
    accountObj = accounts.find((a) => a.id === chosen)!;
  }
  const sp2 = spinner();
  sp2.start('Listing zones…');
  const zones = await listZones(effectiveToken, accountId);
  sp2.stop('✓');
  if (zones.length === 0) fail('No zones on this account — add a domain first');
  let zoneId: string;
  let zoneObj = zones[0]!;
  if (zones.length === 1) {
    zoneId = zoneObj.id;
  } else {
    const chosen = (await select({
      message: 'Select zone (domain)',
      options: zones.map((z) => ({ value: z.id, label: `${z.name} (${z.status})` })),
    })) as string;
    if (isCancel(chosen)) process.exit(0);
    zoneId = chosen;
    zoneObj = zones.find((z) => z.id === chosen)!;
  }

  // 4. Config.
  stepHeader('Step 3: Configuration');
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

  // 5. Fetch release artifact.
  stepHeader('Step 4: Provisioning');
  sp.start('Fetching release artifact…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    sp.stop('✗');
    fail(`Release fetch failed: ${e.message}`);
  }
  sp.stop('✓');

  const migrations = existsSync(release.migrationsDir)
    ? (await readdirSorted(release.migrationsDir))
    : [];

  // 6. D1 provision.
  sp.start('Provisioning D1 database…');
  const d1s = await listD1(effectiveToken, accountId);
  let d1 = d1s.find((d) => d.name === 'mailriz');
  if (!d1) d1 = await createD1(effectiveToken, accountId, 'mailriz');
  sp.stop(`✓ D1 ${d1.id}`);

  // Apply migrations.
  sp.start('Applying migrations…');
  try {
    for (const m of migrations) {
      const sql = await readFile(join(release.migrationsDir, m), 'utf8');
      await d1Query(effectiveToken, accountId, d1.id, sql);
    }
  } catch (e: any) {
    sp.stop('✗');
    fail(`Migration failed: ${e.message}`);
  }
  sp.stop('✓ Migrations applied');

  // 7. R2 provision.
  sp.start('Provisioning R2 buckets…');
  const r2s = await listR2Buckets(effectiveToken, accountId);
  const r2Raw = r2s.find((b) => b.name === 'mailriz-raw') || await createR2Bucket(effectiveToken, accountId, 'mailriz-raw');
  const r2Att = r2s.find((b) => b.name === 'mailriz-attachments') || await createR2Bucket(effectiveToken, accountId, 'mailriz-attachments');
  const r2Html = r2s.find((b) => b.name === 'mailriz-html') || await createR2Bucket(effectiveToken, accountId, 'mailriz-html');
  sp.stop('✓ R2 ready');

  // 8. Deploy worker (wrangler child process with generated wrangler.jsonc).
  sp.start('Deploying Worker…');
  const workerName = 'mailriz';
  try {
    await deployWithWrangler({
      token: effectiveToken,
      accountId,
      workerName,
      releaseDir: release.dir,
      d1Id: d1.id,
      r2Raw: r2Raw.name,
      r2Att: r2Att.name,
      r2Html: r2Html.name,
      adminEmail,
      dashboardHostname,
      authMode,
      sessionHash,
    });
  } catch (e: any) {
    sp.stop('✗');
    fail(`Worker deploy failed: ${e.message}`);
  }
  sp.stop('✓ Worker deployed');

  // 9. Custom domain route.
  sp.start('Binding custom domain…');
  try {
    await createWorkerRoute(effectiveToken, zoneId, `${dashboardHostname}/*`, workerName);
    await createWorkerRoute(effectiveToken, zoneId, dashboardHostname, workerName);
  } catch (e: any) {
    sp.stop('✗');
    note(`Custom domain binding failed (${e.message}). You can add a Worker route manually in the dashboard.`, 'Warning');
  }
  sp.stop('✓ Domain bound');

  // 10. Email Routing.
  sp.start('Enabling Email Routing…');
  try {
    const settings = await getEmailRoutingSettings(effectiveToken, zoneId);
    if (!settings.enabled) {
      await enableEmailRouting(effectiveToken, zoneId);
    }
    // catch-all → worker
    await createEmailRoutingRule(effectiveToken, zoneId, { type: 'all' }, { type: 'worker', value: [workerName] });
  } catch (e: any) {
    sp.stop('✗');
    note(`Email Routing setup failed (${e.message}). Enable it manually in the dashboard: Email → Email Routing → Enable, then add a catch-all rule to Worker "mailriz".`, 'Manual step needed');
  }
  sp.stop('✓ Email Routing ready');

  // 11. Access (optional).
  if (useAccess) {
    sp.start('Configuring Cloudflare Access…');
    try {
      // Attempt Zero Trust app creation; if the token lacks scope, fall back to manual.
      await setupAccess(effectiveToken, accountId, dashboardHostname, adminEmail);
      sp.stop('✓ Access configured');
    } catch (e: any) {
      sp.stop('⚠');
      note(
        `Cloudflare Access could not be configured automatically (${e.message}). ` +
        `Your token may need Zero Trust permissions.\n\n` +
        `Manual steps:\n` +
        `1. Zero Trust → Access → Applications → Add an application\n` +
        `2. Type: Self-hosted. Domain: ${dashboardHostname}\n` +
        `3. Policy: Allow only ${adminEmail}\n` +
        `4. Save. Then set Worker vars ACCESS_TEAM_DOMAIN and ACCESS_AUD.`,
        'Manual Access setup'
      );
    }
  }

  // 12. Verify.
  sp.start('Verifying deployment…');
  let healthy = false;
  try {
    const res = await fetch(`https://${dashboardHostname}/healthz`);
    healthy = res.ok;
  } catch {}
  sp.stop(healthy ? '✓ Healthy' : '⚠ /healthz not reachable yet (DNS may need a minute)');

  const cfg: Config = {
    account_id: accountId,
    zone_id: zoneId,
    zone_name: zoneObj.name,
    worker_name: workerName,
    dashboard_hostname: dashboardHostname,
    admin_email: adminEmail,
    d1_database_id: d1.id,
    r2_raw_bucket: r2Raw.name,
    r2_attachments_bucket: r2Att.name,
    r2_html_bucket: r2Html.name,
    auth_mode: authMode,
    session_password_hash: sessionHash,
    installed_at: new Date().toISOString(),
  };
  await saveConfig(cfg);

  outro(
    pc.green(`Done! Dashboard: https://${dashboardHostname}\n`) +
    pc.cyan(`Test: send an email to anything@${zoneObj.name}\n`) +
    pc.dim(`State saved to ~/.mailriz/config.json (chmod 600)`)
  );
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
  const appId = j.result.id as string;
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
  showBanner();
  stepHeader('MailRiz status');
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');

  note(`Dashboard: ${cfg.dashboard_hostname}\nAdmin: ${cfg.admin_email}\nAuth: ${cfg.auth_mode}`, 'Installation');

  const sp = spinner();
  sp.start('Checking /healthz…');
  try {
    const res = await fetch(`https://${cfg.dashboard_hostname}/healthz`);
    if (res.ok) {
      const j = await res.json();
      sp.stop('✓ Worker healthy');
    } else {
      sp.stop(`⚠ /healthz HTTP ${res.status}`);
    }
  } catch (e: any) {
    sp.stop(`✗ ${e.message}`);
  }
}

// ---------------------------------------------------------------- update

async function cmdUpdate() {
  showBanner();
  stepHeader('MailRiz update');
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');

  const sp = spinner();
  sp.start('Fetching latest release…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    sp.stop('✗');
    fail(`Release fetch failed: ${e.message}`);
  }
  sp.stop('✓');

  const token = (await text({
    message: 'Cloudflare API Token',
    placeholder: 'same as during setup',
    validate: (v) => (v?.length > 20 ? undefined : 'Too short'),
  })) as string;
  if (isCancel(token)) process.exit(0);

  sp.start('Re-deploying Worker (data untouched)…');
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
    sp.stop('✗');
    fail(`Update failed: ${e.message}`);
  }
  sp.stop('✓ Updated');

  outro(pc.green('Worker updated. Data preserved.'));
}

// ---------------------------------------------------------------- destroy

async function cmdDestroy() {
  showBanner();
  stepHeader('MailRiz destroy');
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed.');

  const sure = await confirm({
    message: 'This deletes the Worker, D1 data, and R2 objects. Continue?',
    initialValue: false,
  });
  if (!sure) { cancel('Aborted'); process.exit(0); }
  const sure2 = await confirm({
    message: 'Really sure? Type "yes" to confirm.',
    initialValue: false,
  });
  if (!sure2) { cancel('Aborted'); process.exit(0); }

  const token = (await text({
    message: 'Cloudflare API Token',
    validate: (v) => (v?.length > 20 ? undefined : 'Too short'),
  })) as string;
  if (isCancel(token)) process.exit(0);

  const sp = spinner();
  sp.start('Deleting Worker…');
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.account_id}/workers/scripts/${cfg.worker_name}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
  sp.stop('✓ Worker deleted');

  sp.start('Deleting D1 database…');
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.account_id}/d1/database/${cfg.d1_database_id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
  sp.stop('✓ D1 deleted');

  sp.start('Deleting R2 buckets…');
  for (const b of [cfg.r2_raw_bucket, cfg.r2_attachments_bucket, cfg.r2_html_bucket]) {
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.account_id}/r2/buckets/${b}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  sp.stop('✓ R2 deleted');

  await rm(CONFIG_PATH, { force: true }).catch(() => {});
  outro(pc.green('Destroyed.'));
}

// ---------------------------------------------------------------- main

const cmd = process.argv[2] || 'setup';

if (cmd === 'setup') cmdSetup();
else if (cmd === 'status') cmdStatus();
else if (cmd === 'update') cmdUpdate();
else if (cmd === 'destroy') cmdDestroy();
else {
  console.log(pc.yellow('Unknown command. Use: setup | status | update | destroy'));
  process.exit(1);
}
