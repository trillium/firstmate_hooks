import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStatusLine } from '../status-tail.ts';
import { workerStatusPack } from './questions/v1.ts';
import { EXISTING_FROM_STATE, shadowGuarded, shadowSettings, SHADOW_CONTEXT_LINES } from './shadow.ts';

// Live sample for the shadow numbers. READ-ONLY on $FM_HOME/state/*.status: it parses the
// last N status lines across the files and runs shadowLabel on each. It touches no cursor,
// fleet bead or store; its only write is the eval log (JEV_EVAL_LOG).
export async function collect(home: string, last: number) {
  const dir = join(home, 'state');
  const found = [];
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.status')).sort()) {
    const path = join(dir, name);
    const mtime = (await stat(path)).mtimeMs;
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      const parsed = parseStatusLine(text);
      if (parsed) found.push({ task: name.slice(0, -7), parsed, at: parsed.at ? parsed.at * 1000 : mtime, raw: lines.slice(Math.max(0, index + 1 - SHADOW_CONTEXT_LINES), index + 1).join('\n') });
    });
  }
  return found.sort((a, b) => a.at - b.at).slice(-last);
}

export async function main(argv, env = process.env) {
  const home = argv[argv.indexOf('--home') + 1] ?? env.FM_HOME;
  const last = Number(argv[argv.indexOf('--last') + 1] ?? 30);
  if (!home || !(last > 0)) throw new Error('usage: shadow-sample.ts --home <FM_HOME> --last <N>');
  const sample = await collect(home, last);
  const { timeoutMs } = shadowSettings(env);
  for (const item of sample) {
    await shadowGuarded({ pack: workerStatusPack, raw: item.raw, existing: EXISTING_FROM_STATE[item.parsed.state], timeoutMs });
  }
  console.log(`shadow-sample: labelled ${sample.length} status lines (eval log: ${env.JEV_EVAL_LOG ?? 'default'})`);
}

if (import.meta.main) await main(process.argv.slice(2)).catch(error => { console.error(`shadow-sample: ${error.message}`); process.exit(2); });
