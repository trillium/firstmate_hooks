import { spawnSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'typesafe-jev';
export const KEY_ENV = 'TYPESAFE_API_KEY';

export class JevKeyUnavailable extends Error {
  constructor(reason) {
    super(`TypeSafe API key unavailable: ${reason}`);
    this.name = 'JevKeyUnavailable';
  }
}

// The key comes from TYPESAFE_API_KEY when set (CI, tests), else the macOS Keychain
// generic password for service `typesafe-jev`. It is returned to the caller and goes
// nowhere else: no message in this module ever contains it, and `security`'s stderr is
// not forwarded.
export function readApiKey(env = process.env, run = spawnSync) {
  const fromEnv = env[KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const result = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' });
  if (result.error) throw new JevKeyUnavailable('could not run `security`');
  if (result.status !== 0) throw new JevKeyUnavailable(`no Keychain entry for service ${KEYCHAIN_SERVICE} (exit ${result.status})`);
  const key = String(result.stdout ?? '').trim();
  if (!key) throw new JevKeyUnavailable(`empty Keychain entry for service ${KEYCHAIN_SERVICE}`);
  return key;
}
