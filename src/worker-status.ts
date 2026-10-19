import { DEFAULT_STALE_MS, pidAlive, readHeartbeat } from './heartbeat.ts';
import { queueRoot } from './paths.ts';

// The liveness question, answered as data rather than as a judgement call.
//
// Presence and progress are reported separately on purpose. A worker whose pid is
// still in the table but whose beat has stopped advancing is wedged, and reporting it
// as alive is precisely the failure this exists to catch. `alive` is the strict
// conjunction and is the field an operator should act on.

export { DEFAULT_STALE_MS };

async function describe(root, role, staleAfterMs, now) {
  const beat = await readHeartbeat(root, role);
  if (!beat) {
    return { present: false, running: false, heartbeatFresh: false, alive: false,
      reason: `no ${role} heartbeat: that process has never run against this queue` };
  }
  const updatedAt = Date.parse(beat.updatedAt);
  const ageMs = Number.isFinite(updatedAt) ? now - updatedAt : Infinity;
  const running = pidAlive(beat.pid);
  // A clock that jumped backwards, or a beat that cannot be parsed, is not freshness.
  const fresh = ageMs >= 0 && ageMs <= staleAfterMs;
  const alive = running && fresh;
  return {
    present: true, pid: beat.pid ?? null, running, heartbeatFresh: fresh, alive, ageMs,
    startedAt: beat.startedAt ?? null, updatedAt: beat.updatedAt ?? null,
    restarts: beat.restarts ?? null, lastExit: beat.lastExit ?? null,
    cycles: beat.cycles ?? 0, processed: beat.processed ?? 0, done: beat.done ?? 0,
    failed: beat.failed ?? 0, retried: beat.retried ?? 0, intervalMs: beat.intervalMs ?? null,
    lastResultAt: beat.lastResultAt ?? null, lastError: beat.lastError ?? null,
    reason: alive ? 'running and beating'
      : !running ? `pid ${beat.pid} is not running`
      : `heartbeat is ${ageMs}ms old, stale after ${staleAfterMs}ms: process present but not progressing`,
  };
}

export async function workerStatus({ root = queueRoot(), staleAfterMs = DEFAULT_STALE_MS, now = Date.now() }: Record<string, any> = {}) {
  const worker = await describe(root, 'worker', staleAfterMs, now);
  const supervisor = await describe(root, 'supervisor', staleAfterMs, now);
  return {
    queue: root, staleAfterMs, ...worker,
    // Rule evaluation is live only when the thing that drains the queue is alive, so
    // this is the headline field. A live supervisor over a dead worker is false.
    ruleEvaluationLive: worker.alive,
    cycles: worker.cycles ?? 0, processed: worker.processed ?? 0,
    done: worker.done ?? 0, failed: worker.failed ?? 0, retried: worker.retried ?? 0,
    intervalMs: worker.intervalMs ?? null,
    lastResultAt: worker.lastResultAt ?? null, lastError: worker.lastError ?? null,
    supervisor,
  };
}
