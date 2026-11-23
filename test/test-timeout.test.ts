import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

// bun's default per-test budget is 5000ms and bunfig has no timeout key, so the
// raised budget lives in the package.json test script, which pre-push must run.
test('the test script raises bun\'s default per-test timeout above 5s', () => {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test as string;
  const ms = Number(/--timeout[= ](\d+)/.exec(script)?.[1]);
  assert.ok(ms >= 30000, `test script must pass --timeout >= 30000, got: ${script}`);
});

test('pre-push runs the test script, not bare bun test', () => {
  const hook = readFileSync(join(root, '.githooks', 'pre-push'), 'utf8');
  assert.match(hook, /^"\$BUN" run test$/m);
  assert.doesNotMatch(hook, /^"\$BUN" test$/m);
});
