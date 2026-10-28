import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateUiHandoff, PHONE_RUNBOOK_ID, UI_RUNBOOK_ID } from '../src/ui-handoff.ts';

const HOOK = fileURLToPath(new URL('../src/ui-handoff-hook.ts', import.meta.url));

// Real phrasings from both sides: what an agent says when it hands UI work to the human, and
// what it says when it reports its own work or hands over a genuinely human-only step.
const BLOCK = [
  'Can you click the Approve button in the browser?',
  'Could you please open the Vercel dashboard and check the deploy?',
  'Please open Settings and toggle Developer Mode.',
  'Go to Settings > Privacy & Security and tap Allow.',
  'Sign in and then click Authorize on the page.',
  "You'll need to click \"Connect\" in the dashboard.",
  'You need to go to https://vercel.com/account and paste the token.',
  'Done with the code. Next steps:\n1. Open the Vercel dashboard\n2. Click Deploy',
  'Tap the Trust button on the iPhone, then let me know.',
  "Once you've approved the prompt on your phone, let me know and I'll continue.",
  'Could you approve the permission dialog that popped up?',
  '- Navigate to the Integrations page\n- Enable the toggle for GitHub',
  'I fixed the build. Now just press the Save button and reload the page.',
  'You can click on the link in the sidebar to continue.',
  'Fill in the form on the settings page and submit it.',
  'Open the app on your phone and tap "Allow".',
  'I need you to tap Allow on the phone.',
];

const ALLOW = [
  'I clicked Approve on the dashboard and the deploy went through.',
  "I opened Settings and toggled Developer Mode; it's on now.",
  "I've navigated to the sign-in page in the stable context and left the tab on it. Please sign in with your passkey; I'll continue once you're in.",
  'Enter the 2FA code from your authenticator. The tab is already sitting on the verification page.',
  "I've opened the login page on the phone. Sign in with Face ID, then I'll take it from there.",
  '> Can you click the Approve button?\nThat was your earlier note; I did it.',
  'You said "please click the Approve button" and I did, via interceptor.',
  "No need to click anything; I drove the whole flow myself.",
  "You don't need to open Settings, it's already enabled.",
  'Want me to click Save and reload the page?',
  'The test opens the Settings page and clicks Save, then asserts the toast.',
  'Run `bun test` and review the output.',
  'Open question: should we ship this behind a flag?',
  'Choose option A or B and I will proceed.',
  'Select the approach you prefer: a queue or a cron.',
  'Open the PR when CI is green.',
  'Here is the doc text:\n```\nClick Save, then open Settings.\n```\nI wrote it to the README.',
  'All done. Tests pass and the PR is up: https://github.com/example/repo/pull/1',
  '',
];

test('asks for a UI action the agent can drive: blocks with runbook guidance', () => {
  for (const message of BLOCK) {
    const verdict = evaluateUiHandoff(message);
    assert.equal(verdict.block, true, message);
    assert.match(verdict.reason, new RegExp(UI_RUNBOOK_ID));
    assert.match(verdict.reason, new RegExp(PHONE_RUNBOOK_ID));
    assert.match(verdict.reason, /interceptor/);
  }
});

test('reports, quotes, negations and navigated human-only steps are left alone', () => {
  for (const message of ALLOW) assert.equal(evaluateUiHandoff(message).block, false, message);
});

test('a human-only step is not excused when the agent has not navigated there', () => {
  assert.equal(evaluateUiHandoff('Sign in and then click Authorize on the page.').block, true);
  assert.equal(evaluateUiHandoff('Open the login page and sign in.').block, true);
});

test('non-string messages never block', () => {
  for (const value of [undefined, null, 5, {}]) assert.equal(evaluateUiHandoff(value).block, false);
});

function run(event: object, env: Record<string, string> = {}) {
  return spawnSync('bun', [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, ...env } });
}

test('Stop hook prints one block decision, then lets the continuation stop', () => {
  const event = { hook_event_name: 'Stop', last_assistant_message: 'Can you click the Approve button?' };
  const first = run(event);
  assert.equal(first.status, 0);
  const decision = JSON.parse(first.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /runbooks show runbooks-e8k/);
  const second = run({ ...event, stop_hook_active: true });
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');
});

test('Stop hook is silent for a clean message, other events, the off switch and bad input', () => {
  assert.equal(run({ hook_event_name: 'Stop', last_assistant_message: 'Done; PR is up.' }).stdout, '');
  assert.equal(run({ hook_event_name: 'PostToolUse', last_assistant_message: 'Click Save.' }).stdout, '');
  assert.equal(run({ hook_event_name: 'Stop', last_assistant_message: 'Click Save.' }, { FM_UI_HANDOFF_HOOK: 'off' }).stdout, '');
  const bad = spawnSync('bun', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('Stop hook falls back to the transcript when the payload has no message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-ui-handoff-'));
  try {
    const transcript = join(dir, 't.jsonl');
    await writeFile(transcript, [
      { type: 'user', message: { role: 'user', content: 'deploy it' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Please open the dashboard and click Deploy.' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const result = run({ hook_event_name: 'Stop', transcript_path: transcript });
    assert.equal(JSON.parse(result.stdout).decision, 'block');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
