import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNDECIDED } from '../src/jev/questions/v1.ts';
import {
  buildInboxRoutePack, choicesMissingFromRegistry, classifyInbox, DEFAULT_SECOND_MATES, inboxRouteChoices,
  INBOX_ROUTE_MIN_CONFIDENCE, ownerFromPackVerdict, parseSecondmates, PHRASE_TABLE, prefilterInboxRoute,
  shadowInboxRoute, stalePhraseOwners, type InboxBead, type Mate,
} from '../src/jev/inbox-route.ts';

const fixtureDir = join(import.meta.dir, 'fixtures/jev/inbox-route');
const registryPath = join(fixtureDir, 'secondmates.md');
const beadsPath = join(fixtureDir, 'beads.json');

const loadMates = async () => parseSecondmates(await readFile(registryPath, 'utf8'));

const bead = (partial: Partial<InboxBead> & { id: string }): InboxBead => ({
  title: '', labels: [], description: '', ...partial,
});

function openInbox(): string {
  const result = spawnSync('inbox', ['--readonly', 'list', '--status', 'open', '-n', '0'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `inbox list exited ${result.status}`);
  return result.stdout;
}

test('registry parser reads mate ids and projects, and ignores comment lines', async () => {
  const mates = await loadMates();
  assert.deepEqual(mates, [
    { id: 'macbook-ops', projects: ['federated-markdown-bridge'] },
    { id: 'mini1-ops', projects: [] },
    { id: 'mini0-ops', projects: ['zensical-status', 'portage-forward-frontend'] },
    { id: 'brain-calendar', projects: ['brain-calendar-service'] },
  ]);
});

test('choice list is built from the registry, and a removed mate drops out in the same run', async () => {
  const text = await readFile(registryPath, 'utf8');
  const full = parseSecondmates(text);
  assert.deepEqual(inboxRouteChoices(full), ['primary', 'macbook-ops', 'mini1-ops', 'mini0-ops', 'brain-calendar', 'captain-review', 'other']);
  assert.deepEqual(choicesMissingFromRegistry(inboxRouteChoices(full), text), []);
  assert.deepEqual(choicesMissingFromRegistry(['primary', 'mini2-ops', 'other'], text), ['mini2-ops']);
  const without = text.split('\n').filter(line => !line.startsWith('- brain-calendar ')).join('\n');
  const slim = parseSecondmates(without);
  assert.ok(!inboxRouteChoices(slim).includes('brain-calendar'));
  assert.ok(inboxRouteChoices(full).includes('brain-calendar'));
  assert.deepEqual(stalePhraseOwners(text), []);
  assert.deepEqual(stalePhraseOwners(without), ['brain-calendar']);
  const withoutMini0 = text.split('\n').filter(line => !line.startsWith('- mini0-ops ')).join('\n');
  assert.ok(!inboxRouteChoices(parseSecondmates(withoutMini0)).includes('mini0-ops'));
  assert.deepEqual(stalePhraseOwners(withoutMini0), ['mini0-ops']);
});

test('live secondmates.md agrees with the fixture registry and the phrase owners', async () => {
  if (!existsSync(DEFAULT_SECOND_MATES)) return;
  const live = await readFile(DEFAULT_SECOND_MATES, 'utf8');
  const fixture = await readFile(registryPath, 'utf8');
  const shape = (mates: Mate[]) => mates.map(mate => ({ id: mate.id, projects: mate.projects }));
  assert.deepEqual(shape(parseSecondmates(live)), shape(parseSecondmates(fixture)));
  assert.deepEqual(choicesMissingFromRegistry(inboxRouteChoices(parseSecondmates(live)), live), []);
  assert.deepEqual(stalePhraseOwners(live), []);
  for (const phrase of PHRASE_TABLE) assert.ok(parseSecondmates(live).some(mate => mate.id === phrase.owner), phrase.id);
});

test('layer 0: explicit to: label and ROUTE TO aliases, with no model call', async () => {
  const mates = await loadMates();
  let fetches = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => { fetches++; return prev(...args); }) as typeof fetch;
  try {
    const labeled = classifyInbox(bead({
      id: 'inbox-8ckg',
      title: 'Talon card on Sidecar',
      labels: ['fixer', 'project:sidecar', 'to:macbook-ops'],
      description: 'ROUTE TO: the macbook-ops secondmate (the captain calls it "fixer"). Later the captain says mayor, fixer, zephyr.',
    }), mates);
    assert.equal(labeled.owner, 'macbook-ops');
    assert.equal(labeled.layer, 0);
    assert.equal(labeled.confidence, 1);
    assert.equal(labeled.rule_id, 'l0-to-label');
    assert.equal(labeled.delegate, 'none');

    const mayor = classifyInbox(bead({
      id: 'inbox-em8o',
      title: 'Explore Atlassian auth',
      description: 'ROUTE TO: the first mate (Mayor), who runs on the MacBook.\nFiled by mini1-ops.',
    }), mates);
    assert.equal(mayor.owner, 'primary');
    assert.equal(mayor.layer, 0);
    assert.equal(mayor.confidence, 1);
    assert.equal(mayor.rule_id, 'l0-route-to');

    const alias = classifyInbox(bead({ id: 'alias-fixer', labels: ['to:fixer'] }), mates);
    assert.equal(alias.owner, 'macbook-ops');
    assert.equal(alias.layer, 0);
    const zephyr = classifyInbox(bead({ id: 'alias-zephyr', description: 'ROUTE TO: zephyr' }), mates);
    assert.equal(zephyr.owner, 'mini0-ops');
    assert.equal(zephyr.layer, 0);

    const unregistered = classifyInbox(bead({ id: 'fixture-mini2', labels: ['to:mini2-ops'], title: 'send this somewhere' }), mates);
    assert.equal(unregistered.owner, 'captain-review');
    assert.equal(unregistered.layer, 0);
    assert.equal(unregistered.confidence, 1);
    assert.equal(unregistered.delegate, 'none');
    assert.deepEqual(unregistered.rejected, ['mini2-ops']);
    assert.match(unregistered.rationale, /not an executor/);
    assert.notEqual(unregistered.owner, 'mini2-ops');
    assert.doesNotMatch(JSON.stringify({ owner: unregistered.owner, delegate: unregistered.delegate }), /mini2/);

    const prose = classifyInbox(bead({
      id: 'inbox-902i',
      title: 'Investigate classifier-based routing',
      description: 'Allow explicit destination overrides such as to:macbook-ops. Or Captain review.',
    }), mates);
    assert.equal(prose.owner, 'primary');
    assert.equal(prose.layer, 'fallback');
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = prev; }
});

test('layer 1: captain-review patterns, and the word review alone does not fire', async () => {
  const mates = await loadMates();
  const kv6b = classifyInbox(bead({ id: 'inbox-kv6b', title: 'Product judgment: state the claim you want evidenced' }), mates);
  const cglf = classifyInbox(bead({
    id: 'inbox-cglf',
    title: 'Activate Apple Notes MCP',
    description: 'Before changing anything, identify the exact MCP server and confirm the target; do not disable unrelated tools.',
  }), mates);
  const security = classifyInbox(bead({
    id: 'inbox-490z',
    title: 'Review security and integrate claude-code-voice-mod',
    description: 'Evaluate the repo for security before integration. Do not integrate before the review passes. Only after the security review is complete and acceptable, integrate it.',
  }), mates);
  for (const decision of [kv6b, cglf, security]) {
    assert.equal(decision.owner, 'captain-review');
    assert.equal(decision.layer, 1);
    assert.equal(decision.confidence, 0.9);
    assert.equal(decision.delegate, 'none');
  }
  const hands = classifyInbox(bead({ id: 'fixture-invite', title: 'Remaining step', description: 'The remaining action is to accept an invite on the captain machine.' }), mates);
  assert.equal(hands.owner, 'captain-review');
  assert.equal(hands.layer, 1);
  assert.equal(hands.rule_id, 'l1-hands-on');

  const workflow = classifyInbox(bead({
    id: 'inbox-xi2i',
    title: 'Route all items requiring my review or action into the status feed',
    description: 'Whenever an item needs my attention, decision, approval, review, input, or hands-on action, publish a status entry.',
  }), mates);
  assert.equal(workflow.owner, 'primary');
  assert.equal(workflow.layer, 'fallback');
  const research = classifyInbox(bead({
    id: 'inbox-0sza',
    title: 'Research voice interactions',
    description: 'Compare security/privacy constraints. Recommend a go/no-go conclusion. Explore Talon Hub interactions.',
  }), mates);
  assert.equal(research.owner, 'primary');
  assert.equal(research.layer, 'fallback');
  const guess = classifyInbox(bead({
    id: 'inbox-warc',
    title: 'Transcribe a lecture',
    description: 'Do not guess names or email addresses if unreadable.',
  }), mates);
  assert.equal(guess.owner, 'primary');
});

test('layer 2: projects and phrases, two hits return primary and list both', async () => {
  const mates = await loadMates();
  const bridge = classifyInbox(bead({ id: 'fixture-bridge', title: 'Fix federated-markdown-bridge export' }), mates);
  assert.equal(bridge.owner, 'macbook-ops');
  assert.equal(bridge.layer, 2);
  assert.equal(bridge.confidence, 0.8);
  assert.equal(bridge.rule_id, 'l2-project');
  assert.deepEqual(bridge.hits, ['macbook-ops']);

  const portage = classifyInbox(bead({ id: 'fixture-portage', title: 'Portage Forward frontend build' }), mates);
  assert.equal(portage.owner, 'mini0-ops');
  assert.equal(portage.layer, 2);
  const demo = classifyInbox(bead({ id: 'fixture-demo', title: 'always-on fleet-status dashboard' }), mates);
  assert.equal(demo.owner, 'mini0-ops');
  const sidecar = classifyInbox(bead({ id: 'fixture-sidecar', title: 'Sidecar stream dropped a card' }), mates);
  assert.equal(sidecar.owner, 'macbook-ops');
  const talon = classifyInbox(bead({ id: 'fixture-talon', title: "Update this Mac's Talon config" }), mates);
  assert.equal(talon.owner, 'macbook-ops');
  const calendar = classifyInbox(bead({ id: 'fixture-cal', title: 'brain-calendar-service MCP reads' }), mates);
  assert.equal(calendar.owner, 'brain-calendar');

  const both = classifyInbox(bead({
    id: 'fixture-two-hits',
    title: 'Update federated-markdown-bridge and portage-forward-frontend',
    description: 'Touch federated-markdown-bridge and portage-forward-frontend together.',
  }), mates);
  assert.equal(both.owner, 'primary');
  assert.equal(both.layer, 2);
  assert.equal(both.rule_id, 'l2-ambiguous');
  assert.deepEqual(both.hits, ['macbook-ops', 'mini0-ops']);
  assert.match(both.rationale, /macbook-ops/);
  assert.match(both.rationale, /mini0-ops/);
  assert.equal(both.delegate, 'none');

  const scope = classifyInbox(bead({
    id: 'fixture-scope',
    title: 'Some other product',
    description: 'other product-project work only when the primary routes it',
  }), mates);
  assert.equal(scope.owner, 'primary');
  assert.equal(scope.layer, 'fallback');
  assert.match(scope.rationale, /low-confidence/);

  const federated = classifyInbox(bead({ id: 'inbox-ehym', title: 'Research store', description: 'Include research on distributed/federated training.' }), mates);
  assert.equal(federated.owner, 'primary');
  assert.notEqual(federated.owner, 'mini1-ops');

  const dropped = mates.filter(mate => mate.id !== 'mini0-ops');
  const afterDrop = classifyInbox(bead({ id: 'fixture-portage-gone', title: 'portage-forward-frontend build' }), dropped);
  assert.equal(afterDrop.owner, 'primary');
  assert.ok(!inboxRouteChoices(dropped).includes('mini0-ops'));
});

test('pack choices follow the registry, other never routes, and low confidence is primary', async () => {
  const mates = await loadMates();
  const pack = buildInboxRoutePack(mates);
  const question = pack.questions[0] as { id: string; options: Record<string, string>; threshold: number };
  assert.equal(pack.id, 'inbox-route');
  assert.equal(question.id, 'inbox-route/owner');
  assert.equal(question.threshold, INBOX_ROUTE_MIN_CONFIDENCE);
  assert.deepEqual(Object.keys(question.options), inboxRouteChoices(mates));
  assert.equal(Object.keys(question.options).at(-1), 'other');
  const answer = (value: string, confidence: number) => [{ id: question.id, kind: 'choice' as const, value, distribution: { [value]: confidence }, confidence }];
  assert.equal(pack.decode(answer('other', 0.99)).verdict, UNDECIDED);
  assert.equal(pack.decode(answer('other', 0.99)).reason, 'exit');
  assert.equal(pack.decode(answer('primary', 0.4)).reason, 'low-confidence');
  assert.equal(pack.decode(answer('macbook-ops', 0.8)).verdict, 'macbook-ops');
  const sample = bead({ id: 'fixture-pack' });
  const low = ownerFromPackVerdict(sample, pack.decode(answer('macbook-ops', 0.2)));
  assert.equal(low.owner, 'primary');
  assert.match(low.rationale, /low-confidence/);
  assert.equal(low.delegate, 'none');
  const exit = ownerFromPackVerdict(sample, pack.decode(answer('other', 0.99)));
  assert.equal(exit.owner, 'primary');
  assert.notEqual(exit.owner, 'other');
  const slim = buildInboxRoutePack(mates.filter(mate => mate.id !== 'brain-calendar'));
  assert.ok(!Object.keys((slim.questions[0] as { options: object }).options).includes('brain-calendar'));
  const filtered = prefilterInboxRoute({ title: 'Fix task-q1k8', description: 'See /Users/x/y.ts and https://example.com/a' });
  assert.ok(!filtered.includes('/Users/'));
  assert.ok(filtered.includes('<path>'));
  assert.ok(filtered.includes('<id>'));
});

test('labeled inbox fixtures agree on layer 0 and layer 1, and shadow writes only the audit log', async () => {
  const mates = await loadMates();
  const fixtures: Array<InboxBead & { expect: string; actual: string; layer: 0 | 1 | 2 | 'fallback' }> = JSON.parse(await readFile(beadsPath, 'utf8'));
  assert.equal(fixtures.length, 23);
  const before = openInbox();
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-inbox-route-'));
  const log = join(dir, 'eval.jsonl');
  let fetches = 0;
  let spawns = 0;
  const prevFetch = globalThis.fetch;
  const prevSpawn = Bun.spawn;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => { fetches++; return prevFetch(...args); }) as typeof fetch;
  Bun.spawn = ((() => { spawns++; throw new Error('spawn'); }) as typeof Bun.spawn);
  const previousAct = process.env.INBOX_ROUTE_ACT;
  const previousPromote = process.env.JEV_PROMOTE;
  process.env.INBOX_ROUTE_ACT = '1';
  process.env.JEV_PROMOTE = 'inbox-route:owner';
  try {
    const rows = [];
    for (const fixture of fixtures) {
      const decision = await shadowInboxRoute(fixture, { registry: mates, logPath: log, now: new Date('2026-10-27T00:00:00.000Z') });
      rows.push({ fixture, decision });
    }
    const byLayer = new Map<string, { n: number; agree: number }>();
    for (const row of rows) {
      const key = String(row.decision.layer);
      const slot = byLayer.get(key) ?? { n: 0, agree: 0 };
      slot.n++;
      if (row.decision.owner === row.fixture.actual) slot.agree++;
      byLayer.set(key, slot);
    }
    const lines = ['inbox-route agreement'];
    for (const key of ['0', '1', '2', 'fallback']) {
      const slot = byLayer.get(key) ?? { n: 0, agree: 0 };
      const pct = slot.n ? Math.round((slot.agree / slot.n) * 1000) / 10 : 100;
      lines.push(`layer ${key}: ${slot.agree}/${slot.n} (${pct}%)`);
    }
    console.log(lines.join('\n'));

    for (const row of rows) {
      assert.equal(row.decision.owner, row.fixture.expect, row.fixture.id);
      assert.equal(row.decision.layer, row.fixture.layer, row.fixture.id);
      assert.equal(row.decision.delegate, 'none', row.fixture.id);
      const confidence = row.fixture.layer === 0 ? 1 : row.fixture.layer === 1 ? 0.9 : row.fixture.layer === 2 ? 0.8 : 0;
      assert.equal(row.decision.confidence, confidence, row.fixture.id);
      if (row.fixture.layer === 'fallback') assert.match(row.decision.rationale, /low-confidence/, row.fixture.id);
    }
    const layer0 = rows.filter(row => row.decision.layer === 0);
    const layer1 = rows.filter(row => row.decision.layer === 1);
    assert.ok(layer0.length > 0 && layer0.every(row => row.decision.owner === row.fixture.actual));
    assert.ok(layer1.length > 0 && layer1.every(row => row.decision.owner === row.fixture.actual));
    assert.deepEqual(layer0.map(row => row.fixture.id).sort(), ['inbox-8ckg', 'inbox-em8o']);
    assert.deepEqual(layer1.map(row => row.fixture.id).sort(), ['inbox-490z', 'inbox-cglf', 'inbox-kv6b']);
    const misses = rows.filter(row => row.decision.owner !== row.fixture.actual);
    assert.deepEqual(misses.map(row => row.fixture.id), ['inbox-ehym']);
    assert.equal(misses[0].decision.owner, 'primary');

    const eight = rows.find(row => row.fixture.id === 'inbox-8ckg')!;
    assert.equal(eight.decision.owner, 'macbook-ops');
    assert.equal(eight.decision.confidence, 1);
    const repeated = await shadowInboxRoute(eight.fixture, { registry: mates, logPath: log, now: new Date('2026-10-27T00:00:00.000Z') });
    assert.equal(repeated.delegate, 'none');
    assert.equal(repeated.owner, 'macbook-ops');

    const written = await readdir(dir);
    assert.deepEqual(written, ['eval.jsonl']);
    const text = await readFile(log, 'utf8');
    const logged = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(logged.length, 24);
    assert.ok(logged.every(line => line.kind === 'inbox-route' && line.delegate === 'none' && line.timestamp && line.rationale));
    assert.equal(logged[0].owner, 'macbook-ops');
    assert.equal(logged[0].layer, 0);
    assert.equal(logged[0].confidence, 1);
    assert.doesNotMatch(text, /fm-send\.sh|fm-backlog-handoff\.sh/);
    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
  } finally {
    globalThis.fetch = prevFetch;
    Bun.spawn = prevSpawn;
    if (previousAct === undefined) delete process.env.INBOX_ROUTE_ACT; else process.env.INBOX_ROUTE_ACT = previousAct;
    if (previousPromote === undefined) delete process.env.JEV_PROMOTE; else process.env.JEV_PROMOTE = previousPromote;
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(openInbox(), before);
});

test('inbox-route source has no handoff command', async () => {
  const src = await readFile(new URL('../src/jev/inbox-route.ts', import.meta.url), 'utf8');
  assert.equal(/fm-send\.sh|fm-backlog-handoff\.sh|child_process/.test(src), false);
});
