import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { queueRoot } from './paths.ts';
import { WORKER_ENTRY } from './supervise.ts';

// macOS supervision is launchd. The in-process supervisor (src/supervise.ts) restarts
// a worker that exits; this adds the outer layer that restarts the supervisor itself,
// so a crash, a logout/login cycle, or a reboot does not silently end rule evaluation.
//
// Everything here is local to this user's LaunchAgents directory. Nothing outside the
// user's own account is touched, and `uninstall` removes exactly what `install` wrote.

export const LABEL = 'com.fm-hooks.worker';

export function plistPath(env = process.env) {
  return join(env.HOME ?? homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const escape = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export function renderPlist({
  entry = WORKER_ENTRY,
  env = process.env,
  root = queueRoot(env),
  intervalMs,
  label = LABEL,
  keepAlive = true,
  stdoutPath,
  stderrPath,
}: Record<string, any> = {}) {
  const environment: Record<string, string> = { FM_HOOK_QUEUE: root };
  // Only the variables fm-hooks actually resolves against are carried over. Dumping
  // process.env would write every secret in the caller's environment into a plist file
  // on disk -- a 16 KB file here -- and none of it changes which queue is used.
  for (const [key, value] of Object.entries(env)) {
    if (!/^(FM_HOOK_[A-Z_]+|FM_HOME|XDG_STATE_HOME|STATE_DIR_NAME|PATH|HOME)$/.test(key)) continue;
    if (key === 'FM_HOOK_QUEUE' || key === 'FM_HOOK_WORKER_INTERVAL_MS') continue;
    environment[key] = String(value);
  }
  if (intervalMs) environment.FM_HOOK_WORKER_INTERVAL_MS = String(intervalMs);
  const lines = Object.entries(environment)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `      <key>${escape(key)}</key>\n      <string>${escape(value)}</string>`);
  const home = env.HOME ?? homedir();
  const logDir = join(root, 'worker');
  const out = stdoutPath ?? join(logDir, 'launchd.out.log');
  const err = stderrPath ?? join(logDir, 'launchd.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(entry)}</string>
    <string>--supervise</string>
    <string>--queue</string>
    <string>${escape(root)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${lines.join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <${keepAlive ? 'true' : 'false'}/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escape(out)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(err)}</string>
  <key>WorkingDirectory</key>
  <string>${escape(home)}</string>
</dict>
</plist>
`;
}

export function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

// `launchctl bootout` returns before launchd has actually unloaded the label.
// Bootstrapping in that window fails with "Input/output error", which made install
// fail on the second run -- the exact failure mode of a command an operator runs
// again the moment something looks wrong.
export async function waitForUnload(label = LABEL, { timeoutMs = 10000, pollMs = 100 }: Record<string, any> = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (launchctl(['print', `gui/${process.getuid()}/${label}`]).status !== 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => { setTimeout(resolve, pollMs); });
  }
}

export async function writePlist(options: Record<string, any> = {}) {
  const path = plistPath(options.env ?? process.env);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(join(options.root ?? queueRoot(), 'worker'), { recursive: true });
  await writeFile(path, renderPlist(options), { mode: 0o644 });
  return path;
}

export async function install(options: Record<string, any> = {}) {
  const path = await writePlist(options);
  // bootout first so re-running install on an already-installed label is idempotent
  // rather than a "service already loaded" failure -- and then wait for launchd to
  // finish unloading it before asking it to load the new one.
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  await waitForUnload(LABEL);
  const loaded = launchctl(['bootstrap', `gui/${process.getuid()}`, path]);
  if (loaded.status !== 0) {
    const error: any = new Error(`launchctl bootstrap failed: ${loaded.stderr?.trim() || loaded.stdout?.trim()}`);
    error.stdout = loaded.stdout; error.stderr = loaded.stderr;
    throw error;
  }
  return { path, label: LABEL, stdout: loaded.stdout };
}

export async function uninstall(env = process.env) {
  const path = plistPath(env);
  const booted = launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  await waitForUnload(LABEL);
  await rm(path, { force: true });
  return { path, removed: true, unloaded: await waitForUnload(LABEL),
    stdout: booted.stdout, stderr: booted.stderr };
}

export async function launchdStatus(env = process.env) {
  const path = plistPath(env);
  let installed = false;
  try { await readFile(path, 'utf8'); installed = true; } catch { installed = false; }
  const printed = launchctl(['print', `gui/${process.getuid()}/${LABEL}`]);
  const loaded = printed.status === 0;
  const state = printed.stdout?.match(/^\s*state = (\S+)/m)?.[1] ?? null;
  const pid = printed.stdout?.match(/^\s*pid = (\d+)/m)?.[1];
  return { label: LABEL, plist: path, installed, loaded, state, pid: pid ? Number(pid) : null,
    detail: loaded ? null : (printed.stderr?.trim() || 'not loaded') };
}
