#!/usr/bin/env bun
// Installs the tracked no-JavaScript git hooks into a repository by pointing
// core.hooksPath at its .githooks directory.
//
//   bun scripts/install-githooks.ts [repo-dir]
//
// With no argument it installs into the repo this script lives in (it runs from
// package.json "prepare", so `bun install` does it). Given another repo, it copies this
// repo's .githooks into that repo when it has none of its own, then sets core.hooksPath
// there. Copy this file and .githooks/ to reuse it in any other project.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString().trim();
};

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] ?? sourceRoot);

let top: string;
try { top = git(target, 'rev-parse', '--show-toplevel'); } catch {
  console.log(`install-githooks: ${target} is not a git repository; skipped`);
  process.exit(0);
}

const hooks = join(top, '.githooks');
if (!existsSync(hooks)) {
  mkdirSync(hooks, { recursive: true });
  for (const name of readdirSync(join(sourceRoot, '.githooks'))) copyFileSync(join(sourceRoot, '.githooks', name), join(hooks, name));
}
for (const name of readdirSync(hooks)) chmodSync(join(hooks, name), 0o755);
git(top, 'config', 'core.hooksPath', '.githooks');
console.log(`install-githooks: core.hooksPath=.githooks in ${top} (${readdirSync(hooks).join(', ')})`);
