// link-check.ts — is a job posting URL still live?
//
// No side effects on import (no DB, no schema) so it's safe to use from both Next routes
// (apply pre-submit gate) and standalone ts-node scripts (verify-links.ts).
//
// Strategy: ATS-aware where a public job API gives a definitive answer (Greenhouse, Lever
// return 404 when a job is closed), else a generic GET with redirect-follow + timeout.
// We deliberately GET (not HEAD) — many ATS/CDNs reject or mis-handle HEAD.

export type UrlStatus = 'live' | 'dead' | 'unknown';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const GREENHOUSE_JOB_RE = /(?:job-boards|boards(?:\.[a-z]{2})?)\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i;
const LEVER_JOB_RE = /jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i;

async function fetchStatus(url: string, timeoutMs = 12000): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    return res.status;
  } catch {
    return null; // network error / timeout / DNS → unknown, not dead
  } finally {
    clearTimeout(timer);
  }
}

function statusToVerdict(status: number | null): UrlStatus {
  if (status === null) return 'unknown';
  if (status === 404 || status === 410) return 'dead';
  if (status >= 200 && status < 400) return 'live';
  if (status === 403 || status === 429) return 'unknown'; // blocked/rate-limited, not proof of dead
  if (status >= 500) return 'unknown'; // transient server error
  return 'unknown';
}

/**
 * Check whether a job URL is still live. ATS-precise for Greenhouse/Lever via their public
 * job APIs; generic HTTP status otherwise. Returns 'unknown' on ambiguity (never guesses dead).
 */
export async function checkJobUrl(url: string): Promise<UrlStatus> {
  if (!url) return 'unknown';

  // Fast HTML check for LinkedIn closed postings before running full browser / tailoring pipeline
  if (/linkedin\.com/i.test(url)) {
    try {
      const status = await fetchStatus(url, 5000);
      if (status === 404 || status === 410) return 'dead';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const text = await res.text();
        if (/no longer accepting applications|job is no longer available|this job has expired|posting has closed/i.test(text)) {
          return 'dead';
        }
      }
    } catch {
      return 'unknown';
    }
  }

  // Naukri closed posting check
  if (/naukri\.com/i.test(url)) {
    try {
      const status = await fetchStatus(url, 5000);
      if (status === 404 || status === 410) return 'dead';
    } catch {
      return 'unknown';
    }
  }

  const gh = GREENHOUSE_JOB_RE.exec(url);
  if (gh) {
    const status = await fetchStatus(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}`);
    // API is authoritative: 200 = open, 404 = closed. Fall back to generic if ambiguous.
    if (status === 200) return 'live';
    if (status === 404 || status === 410) return 'dead';
  }

  const lv = LEVER_JOB_RE.exec(url);
  if (lv) {
    const status = await fetchStatus(`https://api.lever.co/v0/postings/${lv[1]}/${lv[2]}`);
    if (status === 200) return 'live';
    if (status === 404 || status === 410) return 'dead';
  }

  return statusToVerdict(await fetchStatus(url));
}
