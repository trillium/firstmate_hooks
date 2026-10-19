import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceJson, replaceRaw } from '../src/atomic.ts';

const fixture = async fn => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-atomic-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('replaceRaw lands the bytes at the requested mode, replaces them in place, and leaves no temporary', async () => fixture(async dir => {
  const path = join(dir, 'rules.json');
  await replaceRaw(path, '{"a":1}\n', { mode: 0o640 });
  assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  await replaceJson(path, { a: 2 });
  assert.equal(await readFile(path, 'utf8'), '{"a":2}\n');
  assert.deepEqual(await readdir(dir), ['rules.json'], 'a successful write leaves only the target');
}));

// robots-59gm1: the cursor writers and the deploy wrote a temporary and renamed it, and
// nothing removed the temporary when the rename failed or the process died between the two.
test('a replacement whose rename fails leaves no temporary behind', async () => fixture(async dir => {
  // A directory where the file belongs makes the rename fail only after the temporary has
  // been written and synced: the failure shape the write itself can hit.
  const path = join(dir, 'cursor.json');
  await mkdir(path);
  await assert.rejects(replaceJson(path, { offset: 1 }), 'a file cannot land on a directory');
  assert.deepEqual(await readdir(dir), ['cursor.json'], 'only the obstacle remains, no temporary');
}));
