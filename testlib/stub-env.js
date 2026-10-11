import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('./store-stub.js', import.meta.url));

// Builds a sandbox of fake store wrappers (projects, review, lifespan, task) plus fake
// fm-inbox.sh / fm-send.sh, all recording to one calls file, and an env that points the
// code under test at them.
export async function withStubs(fn, { stores = ['projects', 'review', 'lifespan', 'task', 'fleet'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-bead-'));
  const env = { ...process.env, STUB_DB: join(dir, 'db.json'), STUB_CALLS: join(dir, 'calls.jsonl'),
    FM_HOOK_QUEUE: join(dir, 'queue'), FM_HOME: join(dir, 'fmhome'), FM_HOOK_FM_BIN_DIR: join(dir, 'fmbin') };
  delete env.STUB_FAIL;
  for (const store of stores) {
    const bin = join(dir, `${store}-bin`);
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${store} "$@"\n`);
    await chmod(bin, 0o755);
    env[`FM_HOOK_${store.toUpperCase()}_BIN`] = bin;
  }
  await writeFile(env.STUB_CALLS, '');
  const calls = async () => (await readFile(env.STUB_CALLS, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const writes = async () => (await calls()).filter(c => ['create', 'close', 'update', 'reopen'].includes(c.argv[0])
    || (c.argv[0] === 'label' && c.argv[1] === 'add')
    || (c.argv[0] === 'comments' && c.argv[1] === 'add'));
  const db = async () => JSON.parse(await readFile(env.STUB_DB, 'utf8').catch(() => '{}'));
  try { await fn({ dir, env, calls, writes, db }); } finally { await rm(dir, { recursive: true, force: true }); }
}
