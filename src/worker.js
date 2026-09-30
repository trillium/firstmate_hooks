#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { runQueue } from './queue.js';

function interpolate(value, job) {
  return value.replaceAll('{operation}', job.operation)
    .replaceAll('{correlationId}', job.correlationId)
    .replaceAll('{ruleId}', job.ruleId);
}

function execute(job) {
  const action = job.action;
  if (!action || typeof action.command !== 'string' || !Array.isArray(action.args) || !action.args.every(x => typeof x === 'string')) {
    throw new Error('action must have a command and string args array');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(action.command, action.args.map(arg => interpolate(arg, job)), {
      cwd: action.cwd || process.cwd(), shell: false, stdio: 'inherit',
      env: { ...process.env, FM_HOOK_CORRELATION_ID: job.correlationId,
        FM_HOOK_IDEMPOTENCY_KEY: job.id }
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`action exited ${code}`)));
  });
}

const results = await runQueue({ execute });
for (const result of results) console.log(JSON.stringify(result));
