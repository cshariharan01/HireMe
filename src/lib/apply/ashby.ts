// Ashby application submitter.
//
// Schema discovery: GET the public application page HTML and extract the embedded
// `sections` JSON via balanced-brace walk (Ashby ships their form definition inline
// in the SPA shell — there's no public schema endpoint).
//
// Submit: POST https://api.ashbyhq.com/posting-api/job-board/<company>/applicationForm.submit?jobPostingId=<uuid>
//   Content-Type: multipart/form-data
//   Body has two parts:
//     1. `applicationForm` — JSON string with { fieldSubmissions: [{path, value}, ...] }
//     2. One multipart part per file field, keyed by a filename token referenced
//        from fieldSubmissions[].value
//
// Field type → value encoding:
//   String / Email / Phone  →  plain string
//   Boolean                 →  true/false (JSON bool, not "yes"/"no")
//   Date                    →  "YYYY-MM-DD"
//   Number                  →  integer
//   ValueSelect             →  string matching available option label
//   MultiValueSelect        →  array of option labels
//   Location                →  { country, region, city }
//   File                    →  { path: "<file_token>" } and the actual binary is a separate multipart part
//   RichText                →  { type: "PlainText", value: "..." }
//
// Docs: https://developers.ashbyhq.com/reference/applicationformsubmit

import { answerScreeningQuestion, type AnswerResult, type ApplyDefaults, type QuestionContext } from './questions';

// --- Schema (parsed from page HTML) -----------------------------------

export type AshbyFieldType =
  | 'String' | 'Email' | 'Phone' | 'Boolean' | 'Date' | 'Number'
  | 'ValueSelect' | 'MultiValueSelect' | 'Location' | 'File' | 'RichText'
  | 'LongText';

export interface AshbySelectableValue {
  label: string;
  value: string | number;
}

export interface AshbyField {
  id: string;
  path: string;                           // submission key (e.g. "_systemfield_name" or a UUID)
  humanReadablePath: string;              // friendly id slug
  title: string;                          // the question text shown to the candidate
  type: AshbyFieldType;
  selectableValues?: AshbySelectableValue[];
  isNullable: boolean;
}

export interface AshbyFieldEntry {
  id: string;
  field: AshbyField;
  isRequired: boolean;
  privacy?: string;
}

export interface AshbySection {
  title?: string;
  fieldEntries: AshbyFieldEntry[];
}

const APPLICATION_PAGE_RE_HOSTS = [
  (company: string, jobId: string) => `https://jobs.ashbyhq.com/${company}/${jobId}/application`,
  // Some company-branded boards use <company>.ashbyhq.com — fall back if jobs.ashbyhq.com 404s
  (company: string, jobId: string) => `https://${company}.ashbyhq.com/${jobId}/application`,
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export async function fetchAshbyApplicationHtml(company: string, jobPostingId: string): Promise<string> {
  for (const buildUrl of APPLICATION_PAGE_RE_HOSTS) {
    const url = buildUrl(company, jobPostingId);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (r.ok) {
        const html = await r.text();
        if (html.includes('"sections":[')) return html;
      }
    } catch { /* try next */ }
  }
  throw new Error(`Could not fetch Ashby application page for ${company}/${jobPostingId}`);
}

// Walk forward from the opening `[` of `"sections":[…]` counting brackets to find the matching close.
// Handles strings (and their escapes) so [ ] inside string literals don't confuse us.
function extractSectionsJson(html: string): AshbySection[] {
  const start = html.indexOf('"sections":[');
  if (start < 0) throw new Error('No sections array in HTML');
  const arrStart = start + '"sections":'.length;
  let i = arrStart + 1; // step past the opening [
  let depthSq = 1;
  let depthCurly = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === '"') {
      // skip string literal
      i++;
      while (i < html.length && html[i] !== '"') {
        if (html[i] === '\\') i++; // skip escape
        i++;
      }
    } else if (c === '[') depthSq++;
    else if (c === ']') {
      depthSq--;
      if (depthSq === 0) {
        const slice = html.slice(arrStart, i + 1);
        return JSON.parse(slice) as AshbySection[];
      }
    } else if (c === '{') depthCurly++;
    else if (c === '}') depthCurly--;
    i++;
  }
  throw new Error('Could not find matching close for sections array');
}

export async function fetchAshbySchema(company: string, jobPostingId: string): Promise<AshbySection[]> {
  const html = await fetchAshbyApplicationHtml(company, jobPostingId);
  return extractSectionsJson(html);
}

// --- Plan building --------------------------------------------------------

export interface AshbyPlannedField {
  path: string;
  type: AshbyFieldType;
  label: string;
  required: boolean;
  // Encoded value ready to drop into the fieldSubmissions array (post-confirm).
  value: unknown;
  // Human-readable rendering for the preview UI.
  display: string;
  warning?: string;
  source?: AnswerResult['source'];
  category?: AnswerResult['category'];
}

export interface AshbySubmissionPlan {
  strategy: 'ashby';
  company: string;
  jobPostingId: string;
  jobTitle: string;
  fields: AshbyPlannedField[];
  attachments: {
    resume?: { filename: string; mimeType: string; bytes: Uint8Array };
    coverLetter?: { filename: string; mimeType: string; bytes: Uint8Array };
  };
}

interface BuildPlanInput {
  company: string;
  jobPostingId: string;
  jobTitle: string;
  jobLocation?: string;
  jobDescription?: string;
  profile: Record<string, unknown>;
  defaults: ApplyDefaults;
  resumePdfBuf?: Uint8Array;
  resumeFilename?: string;
  coverLetterText?: string;
  coverLetterFilename?: string;
}

const SYSTEM_FIELD_FILLERS: Record<string, (p: Record<string, unknown>) => string | null> = {
  _systemfield_name: (p) => (p.name as string) || null,
  _systemfield_email: (p) => (p.email as string) || null,
  _systemfield_phone: (p) => (p.phone as string) || null,
};

function snapToOption(answer: string, opts: AshbySelectableValue[]): AshbySelectableValue | null {
  if (!answer || !opts || opts.length === 0) return null;
  const a = answer.trim().toLowerCase();
  let hit = opts.find((o) => o.label.toLowerCase() === a);
  if (hit) return hit;
  if (['yes', 'y'].includes(a)) hit = opts.find((o) => /^yes\b/i.test(o.label));
  if (['no', 'n'].includes(a)) hit = opts.find((o) => /^no\b/i.test(o.label));
  if (hit) return hit;
  hit = opts.find((o) => a.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(a));
  return hit || null;
}

function parseBoolean(answer: string): boolean | null {
  const a = answer.trim().toLowerCase();
  if (['yes', 'y', 'true', 't', '1'].includes(a)) return true;
  if (['no', 'n', 'false', 'f', '0'].includes(a)) return false;
  return null;
}

export async function buildAshbyPlan(input: BuildPlanInput): Promise<AshbySubmissionPlan> {
  const sections = await fetchAshbySchema(input.company, input.jobPostingId);
  const ctx: QuestionContext = {
    jobTitle: input.jobTitle,
    company: input.company,
    jobLocation: input.jobLocation,
    jobDescription: input.jobDescription,
  };

  const planned: AshbyPlannedField[] = [];
  for (const sec of sections) {
    for (const entry of sec.fieldEntries) {
      const f = entry.field;

      // System fields (name/email/phone) — fill from profile
      if (SYSTEM_FIELD_FILLERS[f.path]) {
        const val = SYSTEM_FIELD_FILLERS[f.path](input.profile);
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: val,
          display: val ?? '',
          warning: !val && entry.isRequired ? 'Missing from profile — add to /profile' : undefined,
          source: 'defaults',
        });
        continue;
      }

      // Resume + cover letter — file fields
      if (f.type === 'File') {
        const isResume = /resume|cv/i.test(f.title) || /resume/i.test(f.humanReadablePath);
        const isCover = /cover.?letter/i.test(f.title) || /cover/i.test(f.humanReadablePath);
        if (isResume && input.resumePdfBuf) {
          const filename = input.resumeFilename || 'resume.pdf';
          planned.push({
            path: f.path,
            type: 'File',
            label: f.title,
            required: entry.isRequired,
            value: { path: filename },
            display: `${filename} (${input.resumePdfBuf.length}B)`,
            source: 'defaults',
          });
        } else if (isCover && input.coverLetterText) {
          const filename = input.coverLetterFilename || 'cover-letter.txt';
          const bytes = new TextEncoder().encode(input.coverLetterText);
          planned.push({
            path: f.path,
            type: 'File',
            label: f.title,
            required: entry.isRequired,
            value: { path: filename },
            display: `${filename} (${bytes.length}B)`,
            source: 'defaults',
          });
        } else if (entry.isRequired) {
          planned.push({
            path: f.path,
            type: 'File',
            label: f.title,
            required: entry.isRequired,
            value: null,
            display: '',
            warning: 'Required file with no candidate file',
          });
        }
        continue;
      }

      // Open-ended / select / boolean — use answerer
      const options = f.selectableValues ? f.selectableValues.map((v) => v.label) : null;
      const answered = await answerScreeningQuestion(f.title, options, input.profile, ctx, input.defaults);

      if (f.type === 'Boolean') {
        const v = parseBoolean(answered.answer);
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: v,
          display: v === null ? '' : v ? 'Yes' : 'No',
          warning: v === null && entry.isRequired ? `Could not parse "${answered.answer}" as yes/no` : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else if (f.type === 'ValueSelect') {
        const snapped = snapToOption(answered.answer, f.selectableValues || []);
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: snapped?.label || null,
          display: snapped?.label || '',
          warning: !snapped && entry.isRequired ? `Could not snap "${answered.answer}" to any option` : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else if (f.type === 'MultiValueSelect') {
        // Find every option mentioned in the answer
        const matches = (f.selectableValues || []).filter((o) =>
          answered.answer.toLowerCase().includes(o.label.toLowerCase()),
        );
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: matches.map((m) => m.label),
          display: matches.map((m) => m.label).join(', '),
          warning: matches.length === 0 && entry.isRequired ? 'No options matched' : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else if (f.type === 'Date') {
        // Try to parse a date out of the answer; otherwise leave blank
        const dateMatch = answered.answer.match(/(\d{4}-\d{2}-\d{2})/);
        const dateVal = dateMatch ? dateMatch[1] : null;
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: dateVal,
          display: dateVal || '',
          warning: !dateVal && entry.isRequired ? 'Could not parse date' : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else if (f.type === 'Number') {
        const numMatch = answered.answer.match(/-?\d+/);
        const num = numMatch ? parseInt(numMatch[0], 10) : null;
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: num,
          display: num !== null ? String(num) : '',
          warning: num === null && entry.isRequired ? 'No number found in answer' : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else if (f.type === 'RichText') {
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: answered.answer ? { type: 'PlainText', value: answered.answer } : null,
          display: answered.answer || '',
          warning: !answered.answer && entry.isRequired ? 'Empty rich-text answer' : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else {
        // String / Email / Phone / LongText — plain text
        planned.push({
          path: f.path,
          type: f.type,
          label: f.title,
          required: entry.isRequired,
          value: answered.answer || null,
          display: answered.answer || '',
          warning: !answered.answer && entry.isRequired ? 'Empty answer for required field' : undefined,
          source: answered.source,
          category: answered.category,
        });
      }
    }
  }

  const attachments: AshbySubmissionPlan['attachments'] = {};
  if (input.resumePdfBuf) {
    attachments.resume = {
      filename: input.resumeFilename || 'resume.pdf',
      mimeType: 'application/pdf',
      bytes: input.resumePdfBuf,
    };
  }
  if (input.coverLetterText) {
    attachments.coverLetter = {
      filename: input.coverLetterFilename || 'cover-letter.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(input.coverLetterText),
    };
  }

  return {
    strategy: 'ashby',
    company: input.company,
    jobPostingId: input.jobPostingId,
    jobTitle: input.jobTitle,
    fields: planned,
    attachments,
  };
}

// --- Submit ---------------------------------------------------------------

export interface AshbySubmitResult {
  ok: boolean;
  status: number;
  submissionId?: string;
  responseBody?: unknown;
  error?: string;
}

export async function submitAshby(plan: AshbySubmissionPlan, opts: { dryRun?: boolean } = {}): Promise<AshbySubmitResult> {
  // Refuse to submit with a REQUIRED answer missing.
  //
  // Null values are skipped when building the body below, so an unanswered required question was
  // silently omitted and the portal rejected the whole application with an opaque 4xx — after the
  // UI had already reported the attempt. Failing here instead names the exact fields, and no
  // half-formed application is ever sent.
  const missingRequired = plan.fields
    .filter((f) => f.required && (f.value === null || f.value === undefined || f.value === ''))
    .map((f) => f.label || f.path);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      status: 0,
      error: `Missing required answer${missingRequired.length === 1 ? '' : 's'}: ${missingRequired.join(', ')}. Add ${missingRequired.length === 1 ? 'it' : 'them'} in the preview above, or fill your profile.`,
    };
  }

  // Build the fieldSubmissions array
  const fieldSubmissions: Array<{ path: string; value: unknown }> = [];
  for (const f of plan.fields) {
    if (f.value === null || f.value === undefined) continue;
    fieldSubmissions.push({ path: f.path, value: f.value });
  }

  const applicationForm = { fieldSubmissions };

  const form = new FormData();
  form.append('applicationForm', JSON.stringify(applicationForm));

  // Attach files — Ashby resolves them by the `path` token used in fieldSubmissions
  if (plan.attachments.resume) {
    const a = plan.attachments.resume;
    const blob = new Blob([new Uint8Array(a.bytes)], { type: a.mimeType });
    form.append(a.filename, blob, a.filename);
  }
  if (plan.attachments.coverLetter) {
    const a = plan.attachments.coverLetter;
    const blob = new Blob([new Uint8Array(a.bytes)], { type: a.mimeType });
    form.append(a.filename, blob, a.filename);
  }

  if (opts.dryRun) {
    const sample: Record<string, string> = { applicationForm: JSON.stringify(applicationForm).slice(0, 500) };
    form.forEach((v, k) => {
      if (k !== 'applicationForm') sample[k] = `<file:${(v as File).name} ${(v as File).size}b>`;
    });
    return { ok: true, status: 0, responseBody: { dryRun: true, fields: sample, fieldSubmissions } };
  }

  const url = `https://api.ashbyhq.com/posting-api/job-board/${plan.company}/applicationForm.submit?jobPostingId=${encodeURIComponent(plan.jobPostingId)}`;
  const r = await fetch(url, { method: 'POST', body: form });
  // Read the body ONCE as text, then try to parse JSON. Calling r.json() and then r.text() on a
  // non-JSON/error response double-reads the stream → "body is unusable: Body has already been read".
  const raw = await r.text().catch(() => '');
  let body: unknown = raw;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

  // Ashby returns { success: bool, errors?: [...] }
  const ok = r.ok && (body as { success?: boolean } | null)?.success !== false;
  const submissionId = (body as { results?: { id?: string } } | null)?.results?.id;
  const errMsg = !ok
    ? (body as { errors?: Array<{ message?: string }> } | null)?.errors?.map((e) => e.message).join('; ')
        || `HTTP ${r.status}`
    : undefined;

  return { ok, status: r.status, responseBody: body, submissionId, error: errMsg };
}
