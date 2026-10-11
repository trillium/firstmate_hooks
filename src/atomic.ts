import { randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// Durable, exclusive, atomic file creation: write a private temporary file, fsync it,
// then hard-link it into place. A second writer of the same path gets EEXIST and loses
// rather than clobbering, so repeated hook deliveries cannot duplicate durable state.
export async function writeOnceRaw(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally { await rm(temporary, { force: true }); }
}

export const writeOnce = (path, value) => writeOnceRaw(path, `${JSON.stringify(value)}\n`);
