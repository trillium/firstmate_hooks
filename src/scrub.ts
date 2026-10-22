import { homedir } from 'node:os';

// Free text from a harness or a Firstmate home (a wake row, an assistant reply, a status
// line) is recorded in the observer's queue, which other tools read and ship. Nothing
// that can authenticate, and nothing that names the user's home, may go with it.
//
// This is a conservative redactor, not a classifier: it removes the shapes credentials
// are known to take and the values of keys that are named like credentials. Ordinary
// prose, commit SHAs (all-hex) and branch names pass through unchanged.

const REDACTED = '[redacted]';

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|PGP[A-Z ]*BLOCK)-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:glpat|npm|pypi|vercel|dop_v1|hf)_[A-Za-z0-9_-]{16,}/g,
];

// `Bearer <token>` / `Basic <credentials>` anywhere, before key=value so the scheme word
// is not mistaken for the value of an `Authorization` key.
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// A URL's userinfo: scheme://user:password@host
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

// The value of a key that is named like a credential: key=value, key: value, "key":"value".
const CREDENTIAL_KEY = '[\\w-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|cookie|user_code|device_code|verification_code|one[_-]?time[_-]?code|otp)s?';
const KEY_VALUE = new RegExp(`(\\b${CREDENTIAL_KEY}["']?\\s*[:=]\\s*)(?!\\[redacted\\])("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`, 'gi');

// A device-flow code spoken in prose: "enter the code ABCD-1234".
const DEVICE_CODE = /(\b(?:user |device |verification |one-time )?code\b[^\n]{0,24}?)\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/gi;

// An opaque 32+ character URL-safe token: mixed case and at least one digit. All-hex
// strings (commit SHAs) and path-like or hyphenated words do not satisfy all three.
const OPAQUE = /(?<![\w/.-])(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{32,}(?![\w/.-])/g;

// /Users/<name>, /home/<name> and the running user's own home collapse to ~.
const HOME_PATH = /\/(?:Users|home)\/[^/\s:'"`)\]]+/g;

function ownHome() {
  try {
    const home = process.env.HOME || homedir();
    return home && home !== '/' && home.length > 1 ? home : null;
  } catch { return null; }
}

export function scrubHome(text: string): string {
  let out = text.replace(HOME_PATH, '~');
  const home = ownHome();
  if (home) out = out.split(home).join('~');
  return out;
}

// Scrub, then cap: a secret is replaced before the cut, so truncation cannot leave half
// of one visible. A capped value ends in an ellipsis and is exactly `max` characters.
export function scrubText(value: unknown, max = 400, { keepNewlines = false }: { keepNewlines?: boolean } = {}): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Line breaks become spaces unless the caller wants its lines kept (at most one blank line).
  text = keepNewlines ? text.replace(/\r\n?/g, '\n').replace(/\t+/g, ' ').replace(/\n{3,}/g, '\n\n') : text.replace(/[\r\n\t]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  text = text.replace(keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '');
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
  text = text.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
  text = text.replace(URL_USERINFO, `$1${REDACTED}@`);
  text = text.replace(KEY_VALUE, `$1${REDACTED}`);
  text = text.replace(DEVICE_CODE, `$1${REDACTED}`);
  text = text.replace(OPAQUE, REDACTED);
  text = scrubHome(text);
  if (Number.isFinite(max) && max > 0 && text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

// A filesystem path, kept usable as a join key on the machine that wrote it: only the
// home prefix is rewritten to ~, so the reader expands it with its own home.
export function scrubPath(value: unknown, max = 512): string | null {
  if (typeof value !== 'string' || !value) return null;
  const path = scrubHome(value.replace(/[\u0000-\u001f\u007f]/g, ''));
  return path.length > max ? `${path.slice(0, max - 1)}…` : path;
}
