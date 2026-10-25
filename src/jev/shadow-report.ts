import { readFile } from 'node:fs/promises';
import { evalLogPath } from './eval-log.ts';

// Reads the eval log, joins each Jev answer line to its shadow outcome by (request_id,
// question_id), and tables agreement by Jev's confidence band, per pack.

export const BANDS = [
  { id: '<0.5', test: c => c < 0.5 },
  { id: '0.5-0.6', test: c => c >= 0.5 && c < 0.6 },
  { id: '0.6-0.9', test: c => c >= 0.6 && c < 0.9 },
  { id: '>=0.9', test: c => c >= 0.9 },
] as const;

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
const packOf = (questionId: string) => String(questionId).split('/')[0];

export function parseLog(text: string) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* a torn line is skipped */ }
  }
  return lines;
}

export function buildReport(lines: any[], { since, pack }: { since?: string; pack?: string } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) throw new Error(`--since is not an ISO date: ${since}`);
  const keep = line => (sinceMs === null || Date.parse(line.timestamp) >= sinceMs);
  const answers = new Map<string, any>();
  for (const line of lines) if (line.kind === 'answer' && keep(line)) answers.set(`${line.request_id}\0${line.question_id}`, line);
  const packs: Record<string, any> = {};
  const slot = id => (packs[id] ??= { pack: id, bands: Object.fromEntries(BANDS.map(b => [b.id, { n: 0, agree: 0, disagree: 0, undecided: 0, latencies: [] as number[], tokens: 0 }])), errors: {} as Record<string, number>, unjoined: 0 });
  for (const line of lines) {
    if (!keep(line)) continue;
    if (line.kind === 'shadow-error') {
      if (pack && line.pack !== pack) continue;
      const entry = slot(line.pack ?? 'unknown');
      entry.errors[line.error] = (entry.errors[line.error] ?? 0) + 1;
    } else if (line.kind === 'outcome' && line.outcome?.source === 'shadow') {
      const id = packOf(line.question_id);
      if (pack && id !== pack) continue;
      const entry = slot(id);
      const answer = answers.get(`${line.request_id}\0${line.question_id}`);
      const o = line.outcome;
      const confidence = answer?.confidence ?? o.jevConfidence;
      if (typeof confidence !== 'number') { entry.unjoined++; continue; }
      const band = entry.bands[BANDS.find(b => b.test(confidence))!.id];
      band.n++;
      if (o.jevVerdict === 'undecided') band.undecided++;
      else if (o.agree) band.agree++;
      else band.disagree++;
      if (typeof o.latencyMs === 'number') band.latencies.push(o.latencyMs);
      band.tokens += o.estimatedTokens ?? 0;
    }
  }
  return Object.values(packs).sort((a: any, b: any) => a.pack.localeCompare(b.pack)).map((entry: any) => ({
    pack: entry.pack,
    bands: BANDS.map(({ id }) => {
      const b = entry.bands[id];
      const sorted = [...b.latencies].sort((x, y) => x - y);
      return { band: id, n: b.n, agree: b.agree, disagree: b.disagree, undecided: b.undecided,
        agreementPct: b.n ? Math.round((b.agree / b.n) * 1000) / 10 : null,
        p50LatencyMs: percentile(sorted, 0.5), p95LatencyMs: percentile(sorted, 0.95),
        totalTokens: b.tokens, meanTokens: b.n ? Math.round(b.tokens / b.n) : null };
    }),
    errors: entry.errors,
    unjoined: entry.unjoined,
  }));
}

const cell = value => (value === null || value === undefined ? '-' : String(value));

export function formatReport(report: any[]): string {
  if (!report.length) return 'no shadow lines in the log';
  const head = ['band', 'n', 'agree', 'disagree', 'undecided', 'agree%', 'p50ms', 'p95ms', 'tokens', 'mean tok'];
  const out = [];
  for (const { pack, bands, errors, unjoined } of report) {
    const rows = [head, ...bands.map(b => [b.band, b.n, b.agree, b.disagree, b.undecided, b.agreementPct === null ? '-' : `${b.agreementPct}%`, b.p50LatencyMs, b.p95LatencyMs, b.totalTokens, b.meanTokens].map(cell))];
    const widths = head.map((_, i) => Math.max(...rows.map(r => r[i].length)));
    out.push(`pack ${pack}`, ...rows.map(r => `  ${r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')}`));
    const errorText = Object.entries(errors).map(([k, v]) => `${k}=${v}`).join(' ');
    out.push(`  shadow errors: ${errorText || 'none'}${unjoined ? `  (outcomes without a confidence: ${unjoined})` : ''}`, '');
  }
  return out.join('\n').trimEnd();
}

export async function main(argv, { log = console.log, env = process.env }: Record<string, any> = {}) {
  const opt: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opt.json = true;
    else if (['--log', '--since', '--pack'].includes(argv[i])) opt[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const text = await readFile(opt.log ?? evalLogPath(env), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const report = buildReport(parseLog(text), { since: opt.since, pack: opt.pack });
  log(opt.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)).catch(error => { console.error(`shadow-report: ${error.message}`); return 2; }));
