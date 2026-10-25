import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchctl, waitForUnload } from './launchd.ts';
import { queueRoot } from './paths.ts';

// The bead poller is its own launchd job beside the worker, so that a wedged rule
// action cannot stop answers from reaching Firstmate and a wedged poller cannot stop
// rules from firing. Same contract as the worker's agent: install is idempotent and
// uninstall removes exactly what install wrote.

export const POLLER_LABEL = 'com.fm-hooks.bead-poller';
export const POLLER_ENTRY = fileURLToPath(new URL('../bin/fm-hooks-bead-poller.ts', import.meta.url));

export const pollerPlistPath = (env = process.env) => join(env.HOME ?? homedir(), 'Library', 'LaunchAgents', `${POLLER_LABEL}.plist`);
const escape = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export function renderPollerPlist({ env = process.env, root = queueRoot(env), intervalMs, entry = POLLER_ENTRY }: Record<string, any> = {}) {
  const home = env.HOME ?? homedir();
  // launchd gives a job almost no PATH. The poller shells out to the store wrappers
  // (~/.local/bin) and Firstmate's scripts, whose shebangs need bun and standard tools.
  const path = [dirname(process.execPath), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    .join(delimiter);
  const environment: Record<string, string> = { HOME: home, PATH: path, FM_HOOK_QUEUE: root,
    FM_HOME: env.FM_HOME ?? join(home, 'fm_home', 'firstmate') };
  for (const [key, value] of Object.entries(env)) {
    if (/^(FM_HOOK_(POLL_[A-Z_]+|[A-Z]+_BIN|FM_BIN_DIR)|JEV_(PROMOTE|SHADOW|SHADOW_TIMEOUT_MS|SHADOW_MAX_PER_CYCLE|EVAL_LOG))$/.test(key)) environment[key] = String(value);
  }
  if (intervalMs) environment.FM_HOOK_POLL_INTERVAL_MS = String(intervalMs);
  const lines = Object.entries(environment).map(([key, value]) => `      <key>${escape(key)}</key>\n      <string>${escape(value)}</string>`);
  const logDir = join(root, 'poller');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${POLLER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(entry)}</string>
    <string>watch</string>
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
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escape(join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(join(logDir, 'launchd.err.log'))}</string>
  <key>WorkingDirectory</key>
  <string>${escape(home)}</string>
</dict>
</plist>
`;
}

export async function installPoller(options: Record<string, any> = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? queueRoot(env);
  const path = pollerPlistPath(env);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(join(root, 'poller'), { recursive: true });
  await writeFile(path, renderPollerPlist({ ...options, env, root }), { mode: 0o644 });
  launchctl(['bootout', `gui/${process.getuid()}/${POLLER_LABEL}`]);
  await waitForUnload(POLLER_LABEL);
  const loaded = launchctl(['bootstrap', `gui/${process.getuid()}`, path]);
  if (loaded.status !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.stderr?.trim() || loaded.stdout?.trim()}`);
  return { path, label: POLLER_LABEL };
}

export async function uninstallPoller(env = process.env) {
  const path = pollerPlistPath(env);
  launchctl(['bootout', `gui/${process.getuid()}/${POLLER_LABEL}`]);
  await waitForUnload(POLLER_LABEL);
  await rm(path, { force: true });
  return { path, removed: true, unloaded: await waitForUnload(POLLER_LABEL) };
}
