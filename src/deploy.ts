import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHECKOUT, cloneDrift } from './drift.ts';
import { stateRoot } from './paths.ts';

// The deploy steps from config/README.md as one command, so a deploy is no longer a
// copy-paste that can be half done. It prints the diff of every rules file it replaces
// first: the diff is the record of what behaviour just changed.

const read = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export async function unifiedDiff(oldText, newText, label) {
  if (oldText === newText) return '';
  const scratch = join(process.env.TMPDIR || '/tmp', `fm-hooks-diff-${randomUUID()}`);
  await writeFile(`${scratch}.old`, oldText ?? '');
  await writeFile(`${scratch}.new`, newText);
  try {
    const run = spawnSync('diff', ['-u', '--label', `${label} (live)`, '--label', `${label} (shipped)`,
      `${scratch}.old`, `${scratch}.new`], { encoding: 'utf8' });
    return run.stdout;
  } finally { await rm(`${scratch}.old`, { force: true }); await rm(`${scratch}.new`, { force: true }); }
}

// Write through a temporary file and rename, so a worker reading the rules during a
// deploy sees the old file or the new one, never half of it.
async function install(path, text, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function deploy({ checkout = CHECKOUT, env = process.env, deployDir = stateRoot(env),
  homeRules = join(env.FM_HOME || join(homedir(), 'fm_home', 'firstmate'), 'fm-hooks.rules.json'),
  dryRun = false, services = false, fetch = true, log = console.log, runService = defaultRunService }: Record<string, any> = {}) {
  const shipped = await readFile(join(checkout, 'config', 'fm-hooks.rules.json'), 'utf8');
  JSON.parse(shipped);
  const result: Record<string, any> = { dryRun, deployDir, changed: [], unchanged: [], warnings: [] };

  const behind = cloneDrift({ repo: checkout, fetch });
  if (behind) { result.warnings.push(behind); log(`warning: ${behind}`); }

  for (const target of [join(deployDir, 'fm-hooks.rules.json'), homeRules]) {
    const live = await read(target);
    const diff = await unifiedDiff(live, shipped, target);
    if (!diff && live !== null) { result.unchanged.push(target); log(`unchanged: ${target}`); continue; }
    result.changed.push(target);
    log(live === null ? `new: ${target}` : `changed: ${target}`);
    if (diff) log(diff.trimEnd());
    if (!dryRun) {
      await mkdir(join(target, '..'), { recursive: true });
      await install(target, shipped, 0o600);
    }
  }

  if (!dryRun) {
    await mkdir(deployDir, { recursive: true });
    const card = join(deployDir, 'fm-hooks-task-card.sh');
    await copyFile(join(checkout, 'bin', 'fm-hooks-task-card.sh'), card);
    await chmod(card, 0o700);
    // The bead action imports ../src, so it is a symlink and must run from the checkout.
    const action = join(deployDir, 'fm-hooks-bead-action');
    await rm(action, { force: true });
    await symlink(join(checkout, 'bin', 'fm-hooks-bead-action.ts'), action);
    log(`installed: ${card}, ${action}`);
    if (services) {
      for (const entry of ['fm-hooks-worker.ts', 'fm-hooks-bead-poller.ts']) {
        const code = runService(join(checkout, 'bin', entry), env);
        log(`${entry} install: exit ${code}`);
        if (code !== 0) throw new Error(`${entry} install failed with exit ${code}`);
      }
    }
  } else log('dry run: nothing written');
  return result;
}

function defaultRunService(entry, env) {
  const args = [entry, 'install'];
  if (entry.endsWith('fm-hooks-worker.ts')) args.push('--interval', '1000');
  return spawnSync(process.execPath, args, { stdio: 'inherit', env }).status ?? 1;
}
