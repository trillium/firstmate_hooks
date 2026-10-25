import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceJson } from '../atomic.ts';
import { evalLogPath } from './eval-log.ts';
import { shadowGuarded, shadowSettings } from './shadow.ts';
import { PACKS } from './questions/v1.ts';
import { storeRouteObservation } from './observe-store-route.ts';
import { ciRollupObservation } from './observe-ci-rollup.ts';

// Shadow observations made inside a hook are written here as small JSON records and drained by
// the poller, so a hook never waits on Jev. One file per observation:
// `<root>/jev-pending/<uuid>.json` = { pack, existing, raw }. Draining asks through
// shadowGuarded (JEV_SHADOW guard, timeout, eval log, error line), at most JEV_SHADOW_MAX_PER_CYCLE
// per cycle; records beyond the cap wait for the next cycle. A record is removed once asked,
// whatever the outcome (a failure is a shadow-error line, never a retry loop).

export const pendingDir = root => join(root, 'jev-pending');
export const PENDING_MAX = 200; // a hook stops queuing past this so a poller that is down cannot grow it without bound

// Hook side: queue what the command shows, only when JEV_SHADOW is on, never throwing.
export async function queueShadowObservations({ command, response, root, env = process.env }: Record<string, any>) {
  try {
    if (!shadowSettings(env).enabled) return [];
    const observations = [storeRouteObservation(command), ciRollupObservation(command, response)].filter(Boolean);
    if (!observations.length) return [];
    await mkdir(pendingDir(root), { recursive: true });
    if ((await readdir(pendingDir(root))).filter(n => n.endsWith('.json')).length >= PENDING_MAX) return [];
    for (const o of observations) await replaceJson(join(pendingDir(root), `${Date.now()}-${randomUUID()}.json`), o);
    return observations;
  } catch { return []; }
}

// Poller side.
export async function drainShadowPending({ root, env = process.env, ask }: Record<string, any>) {
  const settings = shadowSettings(env);
  if (!settings.enabled) return { drained: 0 };
  let names;
  try { names = (await readdir(pendingDir(root))).filter(n => n.endsWith('.json')).sort(); } catch { return { drained: 0 }; }
  let drained = 0;
  for (const name of names.slice(0, settings.maxPerCycle)) {
    const path = join(pendingDir(root), name);
    try {
      const { pack, existing, raw } = JSON.parse(await readFile(path, 'utf8'));
      if (PACKS[pack]) await shadowGuarded({ pack: PACKS[pack], raw, existing, ask, evalLogPath: evalLogPath(env), timeoutMs: settings.timeoutMs });
      drained++;
    } catch { /* a corrupt record is dropped below */ }
    await rm(path, { force: true });
  }
  return { drained };
}
