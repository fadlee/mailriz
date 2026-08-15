/**
 * rizmail-cli — interactive deployment wizard for rizmail.
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
import {
  verifyToken, listAccounts, listZones,
  listD1, createD1, d1Query,
  listR2Buckets, createR2Bucket,
  enableEmailRouting, createEmailRoutingRule, getEmailRoutingSettings,
  createWorkerRoute,
} from './cf';

const execFileP = promisify(execFile);
const CONFIG_DIR = join(homedir(), '.rizmail');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const TMP_DIR = join(CONFIG_DIR, '.temp');
const RELEASE_URL = 'https://github.com/rizkirmdhnnn/rizmail/releases/latest/download/rizmail-worker.tar.gz';

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
  const tarPath = join(TMP_DIR, 'rizmail-worker.tar.gz');
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
      { binding: 'DB', database_name: 'rizmail', database_id: opts.d1Id, migrations_dir: 'migrations' },
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

async function cmdSetup() {
  intro(pc.bold('📬 rizmail setup'));

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
  const token = (await text({
    message: 'Cloudflare API Token (paste)',
    placeholder: 'Scopes: Workers Scripts Edit, D1 Edit, R2 Edit, Email Routing Edit, Zone DNS Edit, Zone Read, Account Read',
    validate: (v) => (v?.length > 20 ? undefined : 'Token looks too short'),
  })) as string;
  if (isCancel(token)) process.exit(0);

  const sp = spinner();
  sp.start('Verifying token…');
  let verified;
  try {
    verified = await verifyToken(token);
  } catch (e: any) {
    sp.stop('✗');
    fail(`Token verification failed: ${e.message}`);
  }
  sp.stop(`✓ Token OK (${verified.id})`);

  // 3. Account + zone selection.
  const accounts = await listAccounts(token);
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
  const zones = await listZones(token, accountId);
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
  const d1s = await listD1(token, accountId);
  let d1 = d1s.find((d) => d.name === 'rizmail');
  if (!d1) d1 = await createD1(token, accountId, 'rizmail');
  sp.stop(`✓ D1 ${d1.id}`);

  // Apply migrations.
  sp.start('Applying migrations…');
  try {
    for (const m of migrations) {
      const sql = await readFile(join(release.migrationsDir, m), 'utf8');
      await d1Query(token, accountId, d1.id, sql);
    }
  } catch (e: any) {
    sp.stop('✗');
    fail(`Migration failed: ${e.message}`);
  }
  sp.stop('✓ Migrations applied');

  // 7. R2 provision.
  sp.start('Provisioning R2 buckets…');
  const r2s = await listR2Buckets(token, accountId);
  const r2Raw = r2s.find((b) => b.name === 'rizmail-raw') || await createR2Bucket(token, accountId, 'rizmail-raw');
  const r2Att = r2s.find((b) => b.name === 'rizmail-attachments') || await createR2Bucket(token, accountId, 'rizmail-attachments');
  const r2Html = r2s.find((b) => b.name === 'rizmail-html') || await createR2Bucket(token, accountId, 'rizmail-html');
  sp.stop('✓ R2 ready');

  // 8. Deploy worker (wrangler child process with generated wrangler.jsonc).
  sp.start('Deploying Worker…');
  const workerName = 'rizmail';
  try {
    await deployWithWrangler({
      token,
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
    await createWorkerRoute(token, zoneId, `${dashboardHostname}/*`, workerName);
    await createWorkerRoute(token, zoneId, dashboardHostname, workerName);
  } catch (e: any) {
    sp.stop('✗');
    note(`Custom domain binding failed (${e.message}). You can add a Worker route manually in the dashboard.`, 'Warning');
  }
  sp.stop('✓ Domain bound');

  // 10. Email Routing.
  sp.start('Enabling Email Routing…');
  try {
    const settings = await getEmailRoutingSettings(token, zoneId);
    if (!settings.enabled) {
      await enableEmailRouting(token, zoneId);
    }
    // catch-all → worker
    await createEmailRoutingRule(token, zoneId, { type: 'all' }, { type: 'worker', value: [workerName] });
  } catch (e: any) {
    sp.stop('✗');
    note(`Email Routing setup failed (${e.message}). Enable it manually in the dashboard: Email → Email Routing → Enable, then add a catch-all rule to Worker "rizmail".`, 'Manual step needed');
  }
  sp.stop('✓ Email Routing ready');

  // 11. Access (optional).
  if (useAccess) {
    sp.start('Configuring Cloudflare Access…');
    try {
      // Attempt Zero Trust app creation; if the token lacks scope, fall back to manual.
      await setupAccess(token, accountId, dashboardHostname, adminEmail);
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
    pc.dim(`State saved to ~/.rizmail/config.json (chmod 600)`)
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
      name: 'rizmail',
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
  intro(pc.bold('📊 rizmail status'));
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed. Run `rizmail-cli setup` first.');

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
  intro(pc.bold('🔄 rizmail update'));
  const cfg = await loadConfig();
  if (!cfg) fail('Not installed. Run `rizmail-cli setup` first.');

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
  intro(pc.bold('💥 rizmail destroy'));
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
