import { extractExperience } from './posting-facts';

export type TargetRole =
  | 'data-engineer'
  | 'big-data-engineer'
  | 'etl'
  | 'cloud-data-engineer'
  | 'data-platform-engineer';

const TARGET_ROLE_PATTERNS: Array<[TargetRole, RegExp]> = [
  ['data-engineer', /\bdata\s+engineer\b/i],
  ['big-data-engineer', /\bbig\s+data\s+engineer\b/i],
  ['etl', /\b(?:etl|extract[,\s-]*transform[,\s-]*load)\s+(?:developer|engineer)\b/i],
  ['cloud-data-engineer', /\bcloud\s+data\s+engineer\b/i],
  ['data-platform-engineer', /\bdata\s+platform\s+engineer\b/i],
];

const EXCLUDED_ROLE_PATTERNS = [
  /\bdata\s+scientist\b/i,
  /\bdata\s+analyst\b/i,
  /\bbusiness\s+analyst\b/i,
  /\bbi\s+analyst\b/i,
  /\bbusiness\s+intelligence\s+analyst\b/i,
  /\bmachine\s+learning\s+engineer\b/i,
  /\bml\s+engineer\b/i,
  /\bai\s+engineer\b/i,
  /\bdata\s+architect\b/i,
  /\bdatabase\s+administrator\b/i,
  /\bdba\b/i,
  /\bdevops\b/i,
  /\bsite\s+reliability\b/i,
  /\bsre\b/i,
];

export function isTargetDataRole(title: string): boolean {
  const value = title || '';

  if (EXCLUDED_ROLE_PATTERNS.some((re) => re.test(value))) {
    return false;
  }

  return TARGET_ROLE_PATTERNS.some(([, re]) => re.test(value));
}

export function matchesPreferredRole(
  title: string | null | undefined,
  preferredRoles?: string[],
): boolean {
  if (!title) return false;
  if (!preferredRoles || preferredRoles.length === 0) return true;
  const lower = title.toLowerCase();
  return preferredRoles.some((role) => {
    const r = role.trim().toLowerCase();
    if (!r) return false;
    // Token-based matching: all words in the preferred role should appear in the title
    const tokens = r.split(/\s+/).filter(Boolean);
    return tokens.every((tok) => lower.includes(tok));
  });
}

/**
/**
 * Seniority compatibility: filters out Lead/Principal/Architect/Staff/Director roles
 * for candidates whose experience is junior or mid-level (<= 4.5 years), unless explicitly
 * targeted in preferredRoles.
 * Also filters out internships, freshers, trainees for experienced candidates (>= 1.5 years).
 */
export function isSeniorityCompatible(
  title: string | null | undefined,
  userYears?: number,
  targetRoles?: string[],
): boolean {
  if (!title) return true;

  if (userYears != null && userYears <= 4.5) {
    const isHighSeniority = /\b(lead|principal|staff|architect|director|head\s+of|manager|vp)\b/i.test(title);
    if (isHighSeniority) {
      const explicitlyTargeted = targetRoles?.some((r) =>
        /\b(lead|principal|staff|architect|director|manager)\b/i.test(r),
      );
      if (!explicitlyTargeted) return false;
    }
  }

  if (userYears != null && userYears >= 1.5) {
    const isJuniorOrIntern = /\b(intern|internship|fresher|trainee|apprentice|entry[- ]?level)\b/i.test(title);
    if (isJuniorOrIntern) return false;
  }

  return true;
}

export function isExperienceCompatible(
  experienceMin: number | null | undefined,
  experienceMax: number | null | undefined,
  fallbackText = '',
  userYears = 3.6,
): boolean {
  const candidateYears = userYears;

  // Use HireSignal's extracted values first when available.
  if (experienceMin != null || experienceMax != null) {
    const min = experienceMin ?? 0;
    const max = experienceMax;

    // Clearly too senior.
    if (min > candidateYears) return false;

    // Clearly too junior, e.g. 1-2 years.
    if (max != null && max < 3) return false;

    return true;
  }

  // Fallback to robust parsing on text/url
  const exp = extractExperience(fallbackText, fallbackText);
  if (exp) {
    const min = exp.min ?? 0;
    const max = exp.max;

    if (min > candidateYears) return false;
    if (max != null && max < 3) return false;
    return true;
  }

  // No experience requirement detected.
  return true;
}

export function isAutofillCapableUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  const value = url.toLowerCase();

  return (
    value.includes('linkedin.com/jobs') ||
    value.includes('naukri.com/job')
  );
}

export function isTargetLocation(
  location: string | null | undefined,
  locationBadge: string | null | undefined,
): boolean {
  const value = (location || '').toLowerCase();
  const badge = (locationBadge || '').toLowerCase();

  // India roles
  if (
    value.includes('india') ||
    value.includes('bengaluru') ||
    value.includes('bangalore') ||
    value.includes('chennai') ||
    value.includes('hyderabad') ||
    value.includes('pune') ||
    value.includes('gurugram') ||
    value.includes('gurgaon') ||
    value.includes('noida') ||
    value.includes('mumbai')
  ) {
    return true;
  }

  // Remote roles
  const isRemote =
    badge === 'remote-global' ||
    badge === 'remote' ||
    (badge.includes('remote') && !badge.includes('neutral')) ||
    value.includes('remote');

  if (isRemote) {
    // Reject clearly US-only remote jobs.
    if (
      value.includes('united states') ||
      value.includes('usa') ||
      value.includes('new york') ||
      value.includes('california') ||
      value.includes('san francisco')
    ) {
      return false;
    }

    return true;
  }

  return false;
}

export function isLocationCompatible(
  location: string | null | undefined,
  locationBadge: string | null | undefined,
  preferredLocations?: string[],
): boolean {
  if (!preferredLocations || preferredLocations.length === 0) {
    return isTargetLocation(location, locationBadge);
  }

  const loc = (location || '').toLowerCase();
  const badge = (locationBadge || '').toLowerCase();

  return preferredLocations.some((pref) => {
    const p = pref.trim().toLowerCase();
    if (!p) return false;
    if (p === 'remote') {
      const isRemote =
        badge === 'remote-global' ||
        badge === 'remote' ||
        (badge.includes('remote') && !badge.includes('neutral')) ||
        loc.includes('remote');
      if (isRemote) {
        if (!preferredLocations.some((pl) => /u\.?s\.?|united states|america/i.test(pl))) {
          if (
            loc.includes('united states') ||
            loc.includes('usa') ||
            loc.includes('new york') ||
            loc.includes('california')
          ) {
            return false;
          }
        }
        return true;
      }
      return false;
    }
    if (p === 'india') {
      return (
        loc.includes('india') ||
        loc.includes('bengaluru') ||
        loc.includes('bangalore') ||
        loc.includes('chennai') ||
        loc.includes('hyderabad') ||
        loc.includes('pune') ||
        loc.includes('gurugram') ||
        loc.includes('gurgaon') ||
        loc.includes('noida') ||
        loc.includes('mumbai') ||
        loc.includes('delhi') ||
        badge.includes('india')
      );
    }
    return loc.includes(p) || badge.includes(p);
  });
}
