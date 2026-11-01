import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/fm-hooks-register.ts';
import { BACKUP_SUFFIX, hookCommand, isOurs, registerClaude, registerPi, withRegistration, withoutRegistration } from '../src/register.ts';

const LINK = '/Users/x/.local/share/fm-hooks';
const COMMAND = hookCommand({ bun: '/bin/bun', link: LINK });
const other = { type: 'command', command: 'bun /x/behavioral/PostToolUse.dispatcher.hook.ts' };

test('isOurs matches the fm-hooks Claude hook command at any checkout, and nothing else', () => {
  for (const command of [
    'FM_HOOK_QUEUE=/q /run/current-system/sw/bin/bun /Users/mini0/code/fm-hooks/src/claude-hook.ts',
    'JEV_SHADOW=1 /Users/t/.bun/bin/bun /Users/t/fm_home/firstmate/projects/fm-hooks/src/claude-hook.ts',
    '/bin/bun /Users/x/.local/share/fm-hooks/src/claude-hook.ts',
    'bun /x/firstmate_hooks/src/claude-hook.ts',
  ]) assert.ok(isOurs(command), command);
  for (const command of ['bun /x/behavioral-hooks/dispatchers/PostToolUse.dispatcher.hook.ts', 'bun /x/other/src/claude-hook.ts', undefined]) assert.ok(!isOurs(command), String(command));
});

test('registration rewrites a stale entry in place, adds a missing one, and leaves every other hook alone', () => {
  const stale = { hooks: {
    PostToolUse: [{ hooks: [other] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'FM_HOOK_QUEUE=/q /bin/bun /Users/mini0/code/fm-hooks/src/claude-hook.ts' }] }],
    PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/bun /Users/mini0/code/fm-hooks/src/claude-hook.ts' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'bun stop.ts' }] }],
  }, model: 'opus' };
  const { settings, changes } = withRegistration(stale, COMMAND);
  assert.deepEqual(settings.hooks.PostToolUse, [{ hooks: [other] }, { matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: COMMAND }] }]);
  assert.deepEqual(settings.hooks.PostToolUseFailure, [{ matcher: 'Bash', hooks: [{ type: 'command', command: COMMAND }] }]);
  assert.deepEqual(settings.hooks.Stop, stale.hooks.Stop);
  assert.equal(settings.model, 'opus');
  assert.equal(changes.length, 2);

  const empty = withRegistration({}, COMMAND);
  assert.equal(empty.settings.hooks.PostToolUse.length, 1);
  assert.equal(empty.settings.hooks.PostToolUseFailure.length, 1);

  const again = withRegistration(settings, COMMAND);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.settings, settings);
});

test('an fm-hooks entry that shares a group with other hooks is moved out of it, not the group retargeted', () => {
  const shared = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [other, { type: 'command', command: '/bin/bun /old/fm-hooks/src/claude-hook.ts' }] }] } };
  const { settings } = withRegistration(shared, COMMAND);
  assert.deepEqual(settings.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [other] }, { matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: COMMAND }] }]);
});

test('duplicate fm-hooks entries collapse to one', () => {
  const twice = { hooks: { PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/bun /a/fm-hooks/src/claude-hook.ts' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/bun /b/fm-hooks/src/claude-hook.ts' }] }] } };
  assert.equal(withRegistration(twice, COMMAND).settings.hooks.PostToolUse.length, 1);
});

test('removal takes only the fm-hooks hooks out', () => {
  const { settings } = withRegistration({ hooks: { PostToolUse: [{ hooks: [other] }] } }, COMMAND);
  assert.deepEqual(withoutRegistration(settings), { hooks: { PostToolUse: [{ hooks: [other] }] } });
});

test('registerClaude writes the file once, keeps the original beside it, follows a symlinked settings file, and a second run changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-register-'));
  try {
    const real = join(dir, 'real.json');
    const settingsPath = join(dir, 'settings.json');
    await writeFile(real, `${JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ hooks: [other] }] } }, null, 2)}\n`, { mode: 0o644 });
    await symlink(real, settingsPath);
    const dry = await registerClaude({ settingsPath, bun: '/bin/bun', link: LINK, dryRun: true });
    assert.equal(dry.changed, true);
    assert.ok(!(await readFile(real, 'utf8')).includes('claude-hook'), 'a dry run writes nothing');
    const first = await registerClaude({ settingsPath, bun: '/bin/bun', link: LINK, env: 'JEV_SHADOW=1' });
    assert.equal(first.changed, true);
    assert.equal(first.settingsPath, await (await import('node:fs/promises')).realpath(real));
    const written = JSON.parse(await readFile(real, 'utf8'));
    assert.equal(written.model, 'opus');
    assert.equal(written.hooks.PostToolUse[1].hooks[0].command, `JEV_SHADOW=1 /bin/bun ${LINK}/src/claude-hook.ts`);
    assert.ok((await readFile(`${real}${BACKUP_SUFFIX}`, 'utf8')).includes('behavioral'), 'the original is kept');
    const second = await registerClaude({ settingsPath, bun: '/bin/bun', link: LINK, env: 'JEV_SHADOW=1' });
    assert.equal(second.changed, false);
    assert.equal(second.backup, null);
    const removed = await registerClaude({ settingsPath, remove: true });
    assert.equal(removed.changed, true);
    assert.ok(!(await readFile(real, 'utf8')).includes('claude-hook'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registerClaude creates a missing settings file, and refuses (touching nothing) one that is not JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-register-'));
  try {
    const created = await registerClaude({ settingsPath: join(dir, 'new', 'settings.json'), bun: '/bin/bun', link: LINK });
    assert.equal(created.changed, true);
    assert.equal(created.backup, null);
    assert.equal(JSON.parse(await readFile(join(dir, 'new', 'settings.json'), 'utf8')).hooks.PostToolUse.length, 1);
    await writeFile(join(dir, 'bad.json'), '{ not json');
    await assert.rejects(registerClaude({ settingsPath: join(dir, 'bad.json'), bun: '/bin/bun', link: LINK }), /not valid JSON/);
    assert.equal(await readFile(join(dir, 'bad.json'), 'utf8'), '{ not json');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registerPi points the extension at the checkout and sets the stale compiled copy aside, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-register-'));
  try {
    await writeFile(join(dir, 'fm-hooks.js'), "export { default } from './fm-hooks-src/pi-extension.js';\n");
    await mkdir(join(dir, 'fm-hooks-src'));
    await writeFile(join(dir, 'fm-hooks-src', 'pi-extension.js'), 'old');
    const first = await registerPi({ extensionsDir: dir, link: LINK });
    assert.equal(first.changed, true);
    assert.equal(await readFile(join(dir, 'fm-hooks.js'), 'utf8'), `export { default } from '${LINK}/src/pi-extension.ts';\n`);
    assert.equal(await readFile(join(dir, `fm-hooks-src${BACKUP_SUFFIX}`, 'pi-extension.js'), 'utf8'), 'old');
    assert.ok((await readFile(join(dir, `fm-hooks.js${BACKUP_SUFFIX}`), 'utf8')).includes('fm-hooks-src'));
    assert.equal((await registerPi({ extensionsDir: dir, link: LINK })).changed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the command line registers both, reports JSON, and a dry run changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-register-'));
  try {
    const out: string[] = [];
    const args = ['all', '--link', LINK, '--bun', '/bin/bun', '--settings', join(dir, 's.json'), '--extensions', join(dir, 'ext')];
    assert.equal(await main([...args, '--dry-run'], { log: (l: string) => out.push(l), env: { HOME: dir } }), 0);
    assert.equal(await readFile(join(dir, 's.json'), 'utf8').catch(() => 'absent'), 'absent');
    assert.equal(await main(args, { log: (l: string) => out.push(l), env: { HOME: dir } }), 0);
    const report = JSON.parse(out.at(-1)!);
    assert.equal(report.claude.changed, true);
    assert.equal(report.pi.changed, true);
    assert.equal(await main(['nonsense'], { error: () => {}, env: { HOME: dir } }), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
