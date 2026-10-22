import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { scrubText, scrubPath } from '../src/scrub.ts';

test('scrubText redacts secrets, tokens, device codes and home paths', () => {
  const cases: [string, RegExp][] = [
    ['token sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD', /sk-ant-/],
    ['key sk-a' + 'bcdefghijklmnopqrstuvwxyz0123456789', /sk-abcdef/],
    ['gh gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789', /ghp_abc/],
    ['pat githu' + 'b_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz0123456789_abcdefghij', /github_pat_/],
    ['slack xo' + 'xb-123456789012-abcdefghijklmnop', /xoxb-/],
    ['aws AKIA' + 'ABCDEFGHIJKLMNOP', /AKIAABCD/],
    ['jwt eyJh' + 'bGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz', /eyJhbGci/],
    ['Authorization: Bearer' + ' abcdef0123456789xyz', /abcdef0123456789xyz/],
    ['curl https://user:h' + 'unter2@example.com/x', /hunter2/],
    ['API_KEY=ab' + 'c123def456 and password: "p@ss w0rd"', /abc123def456|p@ss/],
    ['access_tok' + 'en=zzzz1111', /zzzz1111/],
    ['Enter the code ABCD-1234 at https://github.com/login/device', /ABCD-1234/],
    ['{"user_code":"WXYZ-9876","device_code":"3584d83530557fdd1f46' + 'af8289938c8ef79f9dc5"}', /WXYZ-9876|3584d835/],
    ['-----BEGIN PR' + 'IVATE KEY-----\nMII' + 'EvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----', /MIIEvQ/],
    ['opaque Zx9Qm2Lp8Vt4Rb7Nc1Hd5Jf3Gk6Ws0Ya', /Zx9Qm2Lp8Vt4/],
  ];
  for (const [input, leaked] of cases) {
    const out = scrubText(input);
    assert.doesNotMatch(out, leaked, input);
    assert.match(out, /\[redacted\]|\[home\]|~/, input);
  }
});

test('scrubText rewrites home paths and keeps ordinary text, SHAs and branch names', () => {
  const home = homedir();
  assert.equal(scrubText(`cd ${home}/fm_home/mini0-ops/state && ls`), 'cd ~/fm_home/mini0-ops/state && ls');
  assert.equal(scrubText('see /Users/someone/code/x and /home/other/y'), 'see ~/code/x and ~/y');
  const plain = 'merged fm/fm-hooks-wake-events at 8c510e0 (c660db3a1f0d2e3b4c5d6e7f8091a2b3c4d5e6f7) via PR #12';
  assert.equal(scrubText(plain), plain);
  assert.equal(scrubText('worker is blocked: needs a decision, key=nm-converge-stores'), 'worker is blocked: needs a decision, key=nm-converge-stores');
});

test('scrubText strips control characters and caps length, counting the marker', () => {
  assert.equal(scrubText('a\u0000b\u001b[31mc\r\nd'), 'ab[31mc d');
  const out = scrubText('x'.repeat(1000), 400);
  assert.equal(out.length, 400);
  assert.ok(out.endsWith('…'));
  assert.equal(scrubText('short', 400), 'short');
  assert.equal(scrubText(null), '');
  assert.equal(scrubText(undefined, 10), '');
  assert.equal(scrubText(42 as any), '42');
});

test('a secret cut by the cap is not left half-visible', () => {
  const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(2);
  const out = scrubText(`${'y'.repeat(380)} ${secret}`, 400);
  assert.doesNotMatch(out, /ghp_/);
});

test('scrubPath rewrites the home prefix only', () => {
  assert.equal(scrubPath(`${homedir()}/.claude/projects/p/s.jsonl`), '~/.claude/projects/p/s.jsonl');
  assert.equal(scrubPath('/tmp/x/y.jsonl'), '/tmp/x/y.jsonl');
  assert.equal(scrubPath(null), null);
  assert.equal(scrubPath(''), null);
});
