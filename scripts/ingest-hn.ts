import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';

const ALL_TERMS = [
  'FHIR R4', 'FHIR STU3', 'FHIR R5', 'HL7', 'HL7 v2', 'HL7 CDA',
  'SMART on FHIR', 'CDS Hooks', 'Bulk FHIR', 'FHIR API', 'HL7 FHIR',
  'Epic', 'Cerner', 'Oracle Health', 'Meditech', 'Allscripts',
  'CMS', 'ONC', 'HIPAA', 'USCDI', 'TEFCA', 'Prior Auth',
  'interoperability', 'HITECH', 'PHI', 'CCDA', 'C-CDA',
  'Mirth Connect', 'Azure Health Data Services',
  'AWS HealthLake', 'DICOM', 'IHE', 'SNOMED', 'LOINC', 'ICD-10', 'RxNorm',
];

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || ''
  );
}

function isDomainPriority(text: string): boolean {
  const lower = text.toLowerCase();
  let count = 0;
  for (const term of ALL_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      count++;
      if (count >= 3) return true;
    }
  }
  return false;
}

// Check if this is a top-level job post (not a reply/comment)
function isJobPost(text: string): boolean {
  const firstLine = text.split('\n')[0] || '';
  // Job posts typically start with "Company | Role | Location" or "Company - Role"
  // Replies typically start with lowercase, questions, or references to other posts
  if (firstLine.includes('|') && firstLine.length > 20) return true;
  if (/^[A-Z][A-Za-z\s]+\s*[-–—]\s*/.test(firstLine) && firstLine.length > 15) return true;
  // Filter out obvious non-job comments
  if (/^(I |We |You |This |That |The |It |Is |Are |My |In |On |To |Hi |Hey |Thanks|Great|Also|I'm|I've|Yeah)/i.test(firstLine)) return false;
  if (firstLine.length < 20) return false;
  return true;
}

// Extract location from HN job post format: "Company | Role | Location | ..."
function extractLocation(firstLine: string): string {
  const parts = firstLine.split('|').map(p => p.trim());
  if (parts.length >= 3) {
    // Location is typically the 3rd part
    const loc = parts[2];
    // Validate it looks like a location
    if (/remote|onsite|hybrid|nyc|sf|berlin|london|paris|india|singapore|toronto|worldwide|global|anywhere/i.test(loc)) {
      return loc;
    }
    // Check the other parts too
    for (const part of parts.slice(2)) {
      if (/remote|onsite|hybrid/i.test(part)) return part;
    }
  }
  return '';
}

// Extract company name properly
function extractCompany(firstLine: string): string {
  const parts = firstLine.split('|');
  if (parts.length >= 2) {
    let company = parts[0].trim();
    // Remove URLs from company name
    company = company.replace(/https?:\/\/\S+/g, '').trim();
    // Remove trailing dashes, parens
    company = company.replace(/[\s\-–—(]+$/, '').trim();
    return company.slice(0, 100) || 'Unknown';
  }
  // Try dash separator
  const dashParts = firstLine.split(/\s*[-–—]\s*/);
  if (dashParts.length >= 2) {
    return dashParts[0].trim().slice(0, 100) || 'Unknown';
  }
  return firstLine.slice(0, 60).trim() || 'Unknown';
}

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
// Per-connection: the NORMAL set in src/lib/db.ts does not reach a standalone script, and
// better-sqlite3 defaults to FULL — one fsync per autocommit write.
db.pragma('synchronous = NORMAL');
// REQUIRED once ingest sources run concurrently: WAL allows one writer at a time, and without
// a busy timeout a second writer fails immediately with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 15000');

db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT, company TEXT, title TEXT, location TEXT,
    description TEXT, url TEXT, embedding BLOB,
    domain_priority INTEGER DEFAULT 0, dedup_hash TEXT UNIQUE,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
ensureFreshnessColumns(db);

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, company, title, location, description, url, domain_priority, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at)
`);

async function fetchThread(threadId: string, threadTitle: string) {
  console.log(`  Processing: ${threadTitle} (ID: ${threadId})`);

  const commentsRes = await fetch(
    `https://hn.algolia.com/api/v1/search?tags=comment,story_${threadId}&hitsPerPage=1000`
  );
  const commentsData = await commentsRes.json();
  const comments = commentsData.hits || [];

  let added = 0;
  for (const comment of comments) {
    // Skip child comments (replies) — only top-level job posts
    if (comment.parent_id && comment.parent_id !== parseInt(threadId)) continue;

    const text = stripHtml(comment.comment_text || '');
    const lower = text.toLowerCase();

    // Must contain healthcare IT terms
    const hasTerms = ALL_TERMS.some((term) => lower.includes(term.toLowerCase()));
    if (!hasTerms) continue;

    // Must look like an actual job post
    if (!isJobPost(text)) continue;

    const firstLine = text.split('\n')[0] || '';
    const company = extractCompany(firstLine);
    const location = extractLocation(firstLine);

    const hash = createHash('sha256')
      .update('hn' + threadId + comment.objectID)
      .digest('hex');

    const url = `https://news.ycombinator.com/item?id=${comment.objectID}`;
    const dp = isDomainPriority(text) ? 1 : 0;
    const postedAt = comment.created_at || (comment.created_at_i ? new Date(comment.created_at_i * 1000).toISOString() : null);

    const result = insertStmt.run('hn', company, firstLine.slice(0, 200), location, text, url, dp, hash, postedAt);
    if (result.changes > 0) added++;
  }

  return added;
}

async function main() {
  console.log('Ingesting from Hacker News Who Is Hiring...');
  markSourceAbsent(db, 'hn');

  // Find the most RECENT "Who is hiring" threads.
  //
  // This used to call `/api/v1/search`, which ranks by RELEVANCE, not date — and with no date
  // filter it therefore returned the most *popular* "Who is hiring" threads of all time, forever.
  // Measured consequence: 390 active postings from 2015-2020, none of which ever expired, because
  // these threads are permanent archives so every run refreshed their `last_seen_at` and prune's
  // staleness rule could never fire. Those rows were the bulk of the "old jobs keep coming back"
  // complaint.
  //
  // `/api/v1/search_by_date` sorts by recency, and `numericFilters` bounds it explicitly so even
  // a change in Algolia's ordering can't reintroduce a decade-old thread.
  const monthsBack = parseInt(process.env.HN_MAX_AGE_MONTHS || '6', 10) || 6;
  const cutoffTs = Math.floor(Date.now() / 1000) - monthsBack * 30 * 86400;
  const searchRes = await fetch(
    'https://hn.algolia.com/api/v1/search_by_date' +
      '?query=%22Who+is+hiring%22&tags=story&hitsPerPage=5' +
      `&numericFilters=created_at_i>${cutoffTs}`
  );
  const searchData = await searchRes.json();
  console.log(`  (threads newer than ${new Date(cutoffTs * 1000).toISOString().slice(0, 10)})`);

  if (!searchData.hits || searchData.hits.length === 0) {
    console.log('No "Who is Hiring" threads found');
    db.close();
    return;
  }

  let totalAdded = 0;
  for (const hit of searchData.hits) {
    // Only the real monthly thread. A substring test on "who is hiring" is too loose against the
    // date-sorted feed, which also returns meta-discussion whose titles contain the phrase —
    // observed in the same response: "Show HN: HN Hiring - Search and Filter Who Is Hiring" and
    // "Ask HN: Why is the 'Who is hiring?' post being re-aged?". Scraping their comments would
    // ingest chatter as job postings.
    if (!/^ask hn:\s*who is hiring\?/i.test(hit.title || '')) continue;
    const added = await fetchThread(hit.objectID, hit.title);
    totalAdded += added;
    console.log(`    → ${added} healthcare IT jobs`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`✓ HN total: ${totalAdded} healthcare IT jobs added`);
  db.close();
}

main().catch((err) => { console.error('HN error:', err.message); db.close(); });
