// UI-handoff guard: when the agent's last message asks the human to perform a UI action the
// agent could drive itself ("click Approve", "go to Settings", "sign in and then click ..."),
// block the stop once and point the agent at the UI runbooks. The intent is that the agent is
// always the one who gets the human to the part where the human is actually needed.
//
// Heuristic and deliberately conservative: it matches an explicit request aimed at the human
// (an imperative at a sentence/step start, "can you ...", "you need to ...", "please ...",
// "let me know once you've clicked") whose verb is a UI action. It does not match reports of
// what the agent did, quoted text, negations, or a genuinely human-only step (sign-in, 2FA,
// passcode, consent, cable, purchase) when the message says the agent already navigated there.

export const UI_RUNBOOK_ID = 'runbooks-e8k';
export const PHONE_RUNBOOK_ID = 'runbooks-84o';

// Verbs that are a UI action wherever they follow a request cue.
const STRONG = String.raw`(?:double-click|right-click|click|tap|long-press|swipe|toggle|tick|untick)`;
// Verbs that are a UI action only when a UI object follows within a few words.
const WEAK = String.raw`(?:open|press|hit|select|choose|navigate\s+to|go\s+to|head\s+to|switch\s+to|visit|fill\s+in|fill\s+out|fill|enter|type|paste|approve|allow|grant|authorize|accept|enable|disable|scroll|drag|upload|dismiss|reload|refresh|sign\s+in|log\s+in|log\s+into)`;
const VERB = String.raw`(${STRONG}|${WEAK})`;

const UI_OBJECT = /\b(?:buttons?|links?|tabs?|pages?|menus?|toggles?|checkbox(?:es)?|dropdowns?|settings|preferences|dialogs?|pop-?ups?|prompts?|screens?|icons?|forms?|windows?|sites?|websites?|dashboards?|urls?|browser|simulator|sidebar|panel|modal|banner|notifications?|extension|portal|permissions?|iphone|phone)\b|https?:\/\/|["“][^"”\n]{1,40}["”]/i;

const LEAD = String.raw`(?:please\s+|kindly\s+|then\s+|first,?\s+|next,?\s+|now,?\s+|finally,?\s+|also,?\s+|just\s+|and\s+|so\s+|ok(?:ay)?,?\s+)*`;
const START = String.raw`(?:^|[.!?:;]\s+|,\s*(?:and\s+)?then\s+|\n\s*(?:[-*•]|\d+[.)])?\s*)(?:\*\*|__)?`;
const MODAL = String.raw`(?:(?:will|would|can|could|should|must|may|might|need\s+to|needs\s+to|have\s+to|want\s+to|ought\s+to|'ll|'d)\s+)*`;
const ADVERB = String.raw`(?:then\s+|just\s+|simply\s+|first\s+|also\s+|next\s+|go\s+ahead\s+and\s+)*`;
const DONE = String.raw`(?:clicked|tapped|approved|pressed|selected|toggled|enabled|allowed|granted|authorized|accepted|navigated|opened|signed\s+in|logged\s+in|entered)`;

const CUES: RegExp[] = [
  new RegExp(START + LEAD + VERB + String.raw`\b`, 'gi'),
  new RegExp(String.raw`\b(?:can|could|would|will)\s+you\s+(?:please\s+|just\s+)?` + ADVERB + VERB + String.raw`\b`, 'gi'),
  new RegExp(String.raw`\byou(?:'ll|'d)?\s+` + MODAL + ADVERB + VERB + String.raw`\b`, 'gi'),
  new RegExp(String.raw`\b(?:need|want|ask|require)s?\s+(?:for\s+)?you\s+to\s+` + ADVERB + VERB + String.raw`\b`, 'gi'),
  new RegExp(String.raw`\b(?:please|kindly)\s+(?:just\s+|go\s+ahead\s+and\s+)?` + VERB + String.raw`\b`, 'gi'),
  new RegExp(String.raw`\b(?:once|after|when|until)\s+you(?:'ve|\s+have)\s+()` + DONE + String.raw`\b`, 'gi'),
];

const NEGATION = /(?:n't|\bnot|\bno need|\bnever|\bwithout|\bno longer)\W+(?:\w+\W+){0,3}$/i;
const HUMAN_ONLY = /\b(?:sign(?:ed|ing)?[\s-]?in|log(?:ged|ging)?[\s-]?in|login|password|passkey|passcode|2fa|two-factor|mfa|otp|one-time code|verification code|face id|touch id|biometric|captcha|consent|terms of service|legal|payment|purchase|credit card|cable|usb|physical(?:ly)?)\b/i;
const NAVIGATED = [
  /\bI(?:'ve|'m|\s+have|\s+am)?\s+(?:already\s+)?(?:navigated|opened|brought|driven|taken|left|loaded|landed|parked|put|moved)\b/i,
  /\b(?:tab|page|browser|window|screen|simulator|phone)\b[^.\n]{0,60}\b(?:is|are|sits?|sitting|waiting|parked|open|left)\s+(?:open\s+)?(?:on|at)\b/i,
  /\balready\s+(?:on|at)\b/i,
];

// What does not count as the agent speaking to the human: code, quoted material, and the
// human's own words repeated back.
export function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/\b(?:said|says|wrote|writes|asked|asks|told me|quote[sd]?|you:)\W{0,3}["“][^"”]*["”]/gi, ' ');
}

export interface UiHandoffVerdict { block: boolean; reason?: string; matched?: string; }

// Weak verbs count only when a UI object follows within a few words; strong verbs always do.
const hasUiAction = (verb: string, after: string): boolean => {
  const clause = after.split(/[.!?](?:\s|$)|\n/)[0];
  const near = clause.split(/\s+/).slice(0, 7).join(' ');
  if (new RegExp(String.raw`^${STRONG}$`, 'i').test(verb.trim())) return true;
  return new RegExp(String.raw`\b${STRONG}\b`, 'i').test(near) || UI_OBJECT.test(near);
};

export function findUiRequest(message: string): string | null {
  const text = stripQuoted(message);
  for (const cue of CUES) {
    cue.lastIndex = 0;
    for (let m = cue.exec(text); m; m = cue.exec(text)) {
      const verb = m[1] ?? '';
      const lead = text.slice(Math.max(0, m.index - 40), m.index + m[0].length - verb.length);
      if (NEGATION.test(lead)) continue;
      // The "once you've clicked" cue captures an empty verb: the completed action is the request.
      if (verb === '' || hasUiAction(verb, text.slice(m.index + m[0].length))) return m[0].trim();
    }
  }
  return null;
}

export function evaluateUiHandoff(message: unknown): UiHandoffVerdict {
  if (typeof message !== 'string' || !message.trim()) return { block: false };
  const matched = findUiRequest(message);
  if (!matched) return { block: false };
  // A genuinely human-only step is fine once the message says the agent already got the human there.
  if (HUMAN_ONLY.test(message) && NAVIGATED.some(pattern => pattern.test(message))) return { block: false, matched };
  return { block: true, matched, reason: uiHandoffGuidance() };
}

export function uiHandoffGuidance(): string {
  return [
    'Your last message asks the human to perform a UI action you can probably drive yourself. The goal is that you get the human to the exact point where only they can act, not that they click through the steps.',
    '',
    `1. Load the UI runbook: \`runbooks show ${UI_RUNBOOK_ID}\` ("Drive the captain's web pages with interceptor (by tab and ref)"). For phone UI also \`runbooks show ${PHONE_RUNBOOK_ID}\` (iPhone dev runbook).`,
    '2. Drive it yourself: mbb / interceptor --context stable, by tab and ref. Check state first (for example, are we already signed in?) before asking for anything.',
    '3. Hand the human ONLY the step that truly needs them: sign-in, 2FA, passcode, legal consent, a physical action (cable, purchase). Navigate them to exactly that point first, then say exactly where it is (which tab/screen, what to do, what you will do after).',
    '',
    'If you checked and the step really is human-only and you already navigated there, say so and finish. This check blocks once per turn and will not repeat.',
  ].join('\n');
}
