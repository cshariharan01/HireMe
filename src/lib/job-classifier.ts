export type RemotePolicy = 'global' | 'us-only' | 'country-specific' | 'unknown';

export interface JobClassification {
  remote_policy: RemotePolicy;
  visa_sponsorship: boolean;
  relocation_offered: boolean;
}

const GLOBAL_REMOTE_RE = /\b(work from anywhere|remote worldwide|remote \(global\)|open to international|globally remote|anywhere in the world|fully remote worldwide|remote from anywhere)\b/i;

const US_ONLY_RE = /\b(us(?:a)? only|u\.s\.? only|must be (?:a )?us (?:citizen|resident)|requires us work authorization|authorized to work in the (?:us|united states)|w-?2 only|us residents only|usa residents only|only open to us|based in the us|within the us|united states only|eligible to work in the us)\b/i;

const COUNTRY_RE = /\b(uk only|canada only|germany only|india only|australia only|eu only|within (?:the )?eea|netherlands only)\b/i;

const VISA_RE = /(visa sponsorship|we sponsor|sponsor(?:ing)? visas?|h-?1b|green card sponsor|work permit sponsor|will sponsor)/gi;

const RELOCATION_RE = /(relocation (?:assistance|package|support|help|bonus|benefits?)|relocation offered|will relocate|we'?ll relocate you|relocation available|relocation paid)/gi;

// Negation cues that, when found within ~80 chars before a positive match, flip it.
// "we do not sponsor visas", "visa sponsorship will not be considered", "cannot provide H-1B".
const NEGATION_RE = /\b(no|not|never|won'?t|will not|do not|don'?t|cannot|can not|unable|ineligible|without|nor|not be considered|not provide|not provided|not eligible|are unable to|aren'?t able|currently do not|isn'?t able|won t|no longer)\b/i;

// Returns true iff the haystack has a positive match that is NOT negated by nearby context.
function hasUnnegated(haystack: string, re: RegExp): boolean {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    // Look 80 chars before the match for negation. Also look forward 30 chars
    // because constructions like "visa sponsorship will not be considered" put the
    // negation AFTER the keyword.
    const before = haystack.slice(Math.max(0, start - 80), start);
    const after = haystack.slice(end, Math.min(haystack.length, end + 60));
    if (NEGATION_RE.test(before)) continue;
    if (NEGATION_RE.test(after)) continue;
    return true; // unnegated positive match
  }
  return false;
}

export function classifyJob(title: string, description: string, location: string): JobClassification {
  const haystack = `${title}\n${location}\n${description}`;

  let remote_policy: RemotePolicy;
  if (GLOBAL_REMOTE_RE.test(haystack)) remote_policy = 'global';
  else if (US_ONLY_RE.test(haystack)) remote_policy = 'us-only';
  else if (COUNTRY_RE.test(haystack)) remote_policy = 'country-specific';
  else if (/\bremote\b/i.test(haystack) && !/\bremote,?\s*(us|usa|united states)\b/i.test(haystack)) remote_policy = 'unknown';
  else remote_policy = 'unknown';

  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE),
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE),
  };
}

// For use in ingestion scripts that don't import from src/lib — copy the functions inline.
// Kept in sync manually with the scripts.
