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
    // For candidates with <= 4.5 YOE, filter out Senior titles that typically require 5+ years
    // Only filter "Senior" alone - "Senior Data Engineer" etc where the role itself is senior-level
    const isHighSeniority = /\b(lead|principal|staff|architect|director|head\s+of|manager|vp|sr\.?\s+(?:lead|manager|director|architect|principal))\b/i.test(title);
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
  userYears = 3,
): boolean {
  const candidateYears = userYears;
  const maxReach = candidateYears <= 4 ? candidateYears + 1.0 : candidateYears + 1.5;

  const checkBounds = (min: number | null | undefined, max: number | null | undefined): boolean | null => {
    if (min == null && max == null) return null;
    const mMin = min ?? 0;

    // Clearly too senior if minimum requirement exceeds candidate reach
    if (mMin > maxReach) return false;

    // For candidate <= 4 YOE, if min > candidateYears and max != null && max >= candidateYears + 3.0 (e.g. 4-7, 4-8 yrs for 3.5 YOE candidate)
    if (candidateYears <= 4 && mMin > candidateYears && (max == null || max >= candidateYears + 3.0)) {
      return false;
    }

    // Clearly too junior (e.g. 0-1 or 1-2 for candidate >= 3 YOE)
    if (max != null && max <= Math.max(1.5, candidateYears - 1.0)) return false;

    return true;
  };

  const initialCheck = checkBounds(experienceMin, experienceMax);
  if (initialCheck === false) return false;

  // Fallback to robust parsing on text/url
  const exp = extractExperience(fallbackText, fallbackText);
  if (exp) {
    const expCheck = checkBounds(exp.min, exp.max);
    if (expCheck === false) return false;
  }

  // Scan text for explicit high-experience requirements (5+ years for candidate <= 4.0 YOE)
  if (candidateYears <= 4.0 && fallbackText) {
    const highExpMatches = fallbackText.matchAll(/\b(?:min(?:imum)?\s*(?:of\s*)?|at\s*least\s*|\+\s*)?([5-9]|1\d)\s*\+?\s*(?:years?|yrs?|yoe)(?:\s+(?:of\s+)?(?:hands-on\s+)?(?:relevant\s+)?experience)?/gi);
    for (const m of highExpMatches) {
      const val = parseInt(m[1], 10);
      if (val >= 5) {
        // Exclude company founding / history mentions or lower range bounds like "2-5 years"
        const beforeText = fallbackText.slice(Math.max(0, m.index! - 6), m.index!);
        if (/\d+\s*[-–to]\s*$/i.test(beforeText)) {
          continue;
        }
        const snippet = fallbackText.slice(Math.max(0, m.index! - 40), m.index! + 40);
        if (/company\s+with|founded|established|presence\s+of/i.test(snippet)) {
          continue;
        }
        return false;
      }
    }

    // Also check for explicit "Experience required - 5+ years" or similar phrasing
    const expReqMatch = fallbackText.match(/\bexperience\s*(?:required|needed)?\s*[-:]?\s*([5-9]|1\d)\s*(?:years?|yrs?)/i);
    if (expReqMatch) {
      return false;
    }
  }

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

const INDIA_LOC_RE = /\b(india|bengaluru|bangalore|mumbai|bombay|delhi|new delhi|ncr|gurugram|gurgaon|noida|hyderabad|secunderabad|chennai|madras|pune|kolkata|calcutta|ahmedabad|kochi|cochin|thiruvananthapuram|trivandrum|karnataka|maharashtra|telangana|tamil nadu|tamilnadu|kerala|haryana|uttar pradesh|chandigarh|jaipur|indore|coimbatore|dindigul|madurai|trichy|tiruchirappalli|salem|tirunelveli|vellore|erode)\b/i;

export function isTargetLocation(
  location: string | null | undefined,
  locationBadge: string | null | undefined,
): boolean {
  const value = (location || '').toLowerCase();
  const badge = (locationBadge || '').toLowerCase();

  // India roles
  if (INDIA_LOC_RE.test(value) || badge === 'india') {
    return true;
  }

  // Remote roles
  const isRemote =
    badge === 'remote-global' ||
    badge === 'remote' ||
    (badge.includes('remote') && !badge.includes('neutral')) ||
    value.includes('remote');

  if (isRemote) {
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

  // Explicit remote-global roles match any location preference
  if (badge === 'remote-global' || (loc.includes('remote') && (loc.includes('global') || loc.includes('anywhere') || loc.includes('worldwide')))) {
    return true;
  }

  return preferredLocations.some((pref) => {
    let p = pref.trim().toLowerCase();
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
      return INDIA_LOC_RE.test(loc) || badge === 'india' || loc.includes('india');
    }

    const matchBangalore = (p === 'bengaluru' || p === 'bangalore') && (loc.includes('bengaluru') || loc.includes('bangalore'));
    const matchGurgaon = (p === 'gurugram' || p === 'gurgaon') && (loc.includes('gurugram') || loc.includes('gurgaon'));
    const matchChennai = (p === 'chennai' || p === 'madras') && (loc.includes('chennai') || loc.includes('madras') || loc.includes('mylapore'));
    const matchCoimbatore = (p === 'coimbatore' || p === 'kovai') && (loc.includes('coimbatore') || loc.includes('kovai'));

    return matchBangalore || matchGurgaon || matchChennai || matchCoimbatore || loc.includes(p) || badge.includes(p);
  });
}

