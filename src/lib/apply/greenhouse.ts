// Greenhouse Job Board API submitter.
//
// Two-step flow:
//   1. GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>?questions=true
//      → returns { questions: [...], demographic_questions: [...], compliance: [...], location_questions: [...] }
//   2. POST https://boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>
//      → multipart/form-data with fields keyed by question.fields[].name
//
// Field types we handle:
//   input_text, textarea           → string
//   multi_value_single_select      → number (value id, NOT label)
//   multi_value_multi_select       → number[]
//   input_file                     → File / Blob
//
// Docs: https://developers.greenhouse.io/job-board.html#submit-an-application

import { answerScreeningQuestion, type AnswerResult, type ApplyDefaults, type QuestionContext } from './questions';

// --- Schema (parsed from GET response) ----------------------------------

export type GhFieldType = 'input_text' | 'textarea' | 'multi_value_single_select' | 'multi_value_multi_select' | 'input_file';

export interface GhFieldValueOption {
  label: string;
  value: number | string;
}

export interface GhField {
  name: string;                              // e.g. 'first_name' or 'question_29563618003'
  type: GhFieldType;
  values?: GhFieldValueOption[];             // present for multi_value_*_select
}

export interface GhQuestion {
  label: string;                             // human-readable label (e.g. "First Name")
  required: boolean;
  fields: GhField[];                         // usually 1, but resume has 2 (file OR text)
  description_plain?: string;
}

export interface GhJobSchema {
  questions: GhQuestion[];
  demographic_questions?: { questions?: GhQuestion[] };
  compliance?: Array<{ type: string; questions: GhQuestion[] }>;
  location_questions?: GhQuestion[];
}

export async function fetchGreenhouseSchema(slug: string, jobId: string): Promise<GhJobSchema> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?questions=true`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Greenhouse schema fetch failed: HTTP ${r.status} for ${url}`);
  return (await r.json()) as GhJobSchema;
}

// Flatten the schema's various question-bearing arrays into one list.
export function allQuestions(schema: GhJobSchema): GhQuestion[] {
  const out: GhQuestion[] = [];
  out.push(...(schema.questions || []));
  out.push(...(schema.location_questions || []));
  for (const c of schema.compliance || []) out.push(...(c.questions || []));
  if (schema.demographic_questions?.questions) out.push(...schema.demographic_questions.questions);
  return out;
}

// --- Plan building (answers per field) ----------------------------------

export interface GhPlannedField {
  name: string;
  type: GhFieldType;
  label: string;
  required: boolean;
  // For text fields: the answer text
  // For select fields: the chosen option { label, value }
  // For file fields: the filename + size; the actual binary is attached at submit time
  value: string | GhFieldValueOption | { filename: string; mimeType: string; sizeBytes: number } | null;
  warning?: string;
  source?: AnswerResult['source'];
  category?: AnswerResult['category'];
}

export interface GhSubmissionPlan {
  strategy: 'greenhouse';
  slug: string;
  jobId: string;
  jobTitle: string;
  company: string;
  fields: GhPlannedField[];
  attachments: {
    resume?: { filename: string; mimeType: string; bytes: Uint8Array };
    coverLetter?: { filename: string; mimeType: string; bytes: Uint8Array };
  };
}

interface BuildPlanInput {
  slug: string;
  jobId: string;
  jobTitle: string;
  company: string;
  profile: Record<string, unknown>;
  defaults: ApplyDefaults;
  resumePdfBuf?: Uint8Array;
  resumeFilename?: string;
  coverLetterText?: string;
  coverLetterFilename?: string;
  jobLocation?: string;
  jobDescription?: string;
}

const STANDARD_FIELD_FILLERS: Record<string, (profile: Record<string, unknown>) => string | null> = {
  first_name: (p) => firstName((p.name as string) || ''),
  last_name: (p) => lastName((p.name as string) || ''),
  email: (p) => (p.email as string) || null,
  phone: (p) => (p.phone as string) || null,
};

function firstName(full: string): string | null {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;
  return parts[0];
}

function lastName(full: string): string | null {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return parts.slice(1).join(' ');
}

// Snap a free-text answer to a select-option value (case-insensitive, fuzzy).
function snapToOption(answer: string, options: GhFieldValueOption[]): GhFieldValueOption | null {
  if (!answer) return null;
  const a = answer.trim().toLowerCase();
  // Exact label match
  let hit = options.find((o) => o.label.toLowerCase() === a);
  if (hit) return hit;
  // "Yes"/"No" normalization
  if (['yes', 'y'].includes(a)) hit = options.find((o) => /^yes\b/i.test(o.label));
  if (['no', 'n'].includes(a)) hit = options.find((o) => /^no\b/i.test(o.label));
  if (hit) return hit;
  // Substring contains
  hit = options.find((o) => a.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(a));
  return hit || null;
}

export async function buildGreenhousePlan(input: BuildPlanInput): Promise<GhSubmissionPlan> {
  const schema = await fetchGreenhouseSchema(input.slug, input.jobId);
  const qs = allQuestions(schema);
  const ctx: QuestionContext = {
    jobTitle: input.jobTitle,
    company: input.company,
    jobLocation: input.jobLocation,
    jobDescription: input.jobDescription,
  };

  const planned: GhPlannedField[] = [];
  for (const q of qs) {
    for (const field of q.fields) {
      // Skip resume_text / cover_letter_text if we'll attach files
      if (field.name === 'resume_text' && input.resumePdfBuf) continue;
      if (field.name === 'cover_letter_text' && input.coverLetterText) continue;

      // Standard known fields (name/email/phone)
      if (STANDARD_FIELD_FILLERS[field.name]) {
        const val = STANDARD_FIELD_FILLERS[field.name](input.profile);
        planned.push({
          name: field.name,
          type: field.type,
          label: q.label,
          required: q.required,
          value: val,
          warning: !val && q.required ? `Missing in profile — add to /profile` : undefined,
          source: 'defaults',
        });
        continue;
      }

      // File inputs
      if (field.type === 'input_file') {
        if (field.name === 'resume' && input.resumePdfBuf) {
          planned.push({
            name: field.name,
            type: field.type,
            label: q.label,
            required: q.required,
            value: { filename: input.resumeFilename || 'resume.pdf', mimeType: 'application/pdf', sizeBytes: input.resumePdfBuf.length },
            source: 'defaults',
          });
        } else if (field.name === 'cover_letter' && input.coverLetterText) {
          // Cover letter as plain text file
          const bytes = new TextEncoder().encode(input.coverLetterText);
          planned.push({
            name: field.name,
            type: field.type,
            label: q.label,
            required: q.required,
            value: { filename: input.coverLetterFilename || 'cover-letter.txt', mimeType: 'text/plain', sizeBytes: bytes.length },
            source: 'defaults',
          });
        } else if (q.required) {
          planned.push({
            name: field.name,
            type: field.type,
            label: q.label,
            required: q.required,
            value: null,
            warning: 'Required file field with no candidate file',
          });
        }
        continue;
      }

      // Free text / textarea / select — ask the answerer
      const options = field.values ? field.values.map((v) => v.label) : null;
      const answered = await answerScreeningQuestion(q.label, options, input.profile, ctx, input.defaults);

      if (field.type === 'multi_value_single_select') {
        const snapped = snapToOption(answered.answer, field.values || []);
        planned.push({
          name: field.name,
          type: field.type,
          label: q.label,
          required: q.required,
          value: snapped,
          warning: !snapped && q.required ? `Could not snap "${answered.answer}" to any option` : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else if (field.type === 'multi_value_multi_select') {
        // Multi-select: try to find multiple options the answer mentions
        const matches: GhFieldValueOption[] = [];
        for (const opt of field.values || []) {
          if (answered.answer.toLowerCase().includes(opt.label.toLowerCase())) matches.push(opt);
        }
        planned.push({
          name: field.name,
          type: field.type,
          label: q.label,
          required: q.required,
          value: matches.length > 0 ? (matches[0] as GhFieldValueOption) : null, // primary; submit will use all
          warning: matches.length === 0 && q.required ? `No options matched` : undefined,
          source: answered.source,
          category: answered.category,
        });
      } else {
        // input_text / textarea
        planned.push({
          name: field.name,
          type: field.type,
          label: q.label,
          required: q.required,
          value: answered.answer || null,
          warning: !answered.answer && q.required ? `Empty answer for required question` : undefined,
          source: answered.source,
          category: answered.category,
        });
      }
    }
  }

  const attachments: GhSubmissionPlan['attachments'] = {};
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
    strategy: 'greenhouse',
    slug: input.slug,
    jobId: input.jobId,
    jobTitle: input.jobTitle,
    company: input.company,
    fields: planned,
    attachments,
  };
}

// --- Submit ---------------------------------------------------------------

export interface SubmitResult {
  ok: boolean;
  status: number;
  submissionId?: string;
  responseBody?: unknown;
  error?: string;
}

export async function submitGreenhouse(plan: GhSubmissionPlan, opts: { dryRun?: boolean } = {}): Promise<SubmitResult> {
  // Refuse to submit with a REQUIRED answer missing.
  //
  // Null values are skipped when building the body below, so an unanswered required question was
  // silently omitted and the portal rejected the whole application with an opaque 4xx — after the
  // UI had already reported the attempt. Failing here instead names the exact fields, and no
  // half-formed application is ever sent.
  const missingRequired = plan.fields
    .filter((f) => f.required && (f.value === null || f.value === undefined || f.value === ''))
    .map((f) => f.label || f.name);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      status: 0,
      error: `Missing required answer${missingRequired.length === 1 ? '' : 's'}: ${missingRequired.join(', ')}. Add ${missingRequired.length === 1 ? 'it' : 'them'} in the preview above, or fill your profile.`,
    };
  }

  const form = new FormData();

  for (const f of plan.fields) {
    if (f.value === null || f.value === undefined) continue;

    if (f.type === 'input_text' || f.type === 'textarea') {
      form.append(f.name, String(f.value));
    } else if (f.type === 'multi_value_single_select') {
      const opt = f.value as GhFieldValueOption;
      if (opt && typeof opt === 'object' && 'value' in opt) {
        form.append(f.name, String(opt.value));
      }
    } else if (f.type === 'input_file') {
      // Resolve the attachment binary from plan.attachments
      const attach = f.name === 'resume' ? plan.attachments.resume : f.name === 'cover_letter' ? plan.attachments.coverLetter : null;
      if (attach) {
        const blob = new Blob([new Uint8Array(attach.bytes)], { type: attach.mimeType });
        form.append(f.name, blob, attach.filename);
      }
    }
    // multi_value_multi_select: not yet implemented (rare); user can manually edit in preview
  }

  if (opts.dryRun) {
    // Don't actually POST. Just return what we would send.
    const sample: Record<string, string> = {};
    form.forEach((v, k) => {
      sample[k] = typeof v === 'string' ? v.slice(0, 80) : `<file:${(v as File).name} ${(v as File).size}b>`;
    });
    return { ok: true, status: 0, responseBody: { dryRun: true, fields: sample } };
  }

  const url = `https://boards-api.greenhouse.io/v1/boards/${plan.slug}/jobs/${plan.jobId}`;
  const r = await fetch(url, { method: 'POST', body: form });
  // Read the body ONCE as text, then try to parse JSON. Calling r.json() and then r.text() on a
  // non-JSON/error response double-reads the stream → "body is unusable: Body has already been
  // read", which masked the real failure (e.g. closed posting / 403 / validation error).
  const raw = await r.text().catch(() => '');
  let body: unknown = raw;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

  return {
    ok: r.ok,
    status: r.status,
    responseBody: body,
    submissionId: (body as { id?: string | number } | null)?.id ? String((body as { id: string | number }).id) : undefined,
    error: r.ok ? undefined : (body as { error?: string } | null)?.error || `HTTP ${r.status}`,
  };
}
