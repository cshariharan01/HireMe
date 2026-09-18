// Multi-resume helpers. The `resumes` table is the library; my_profile (id=1) is the live
// "active profile" that every consumer (matcher, evaluate, generate, apply) reads. Switching
// the active resume mirrors it into my_profile, so those consumers need no changes.

import db from './db';

/** Copy a resume's fields (incl. original PDF bytes + LaTeX template) into the singleton my_profile row. */
export function mirrorResumeToProfile(resumeId: number): boolean {
  const r = db.prepare('SELECT raw_text, parsed_json, embedding, pdf_blob, pdf_filename, resume_tex FROM resumes WHERE id = ?').get(resumeId) as
    | { raw_text: string | null; parsed_json: string | null; embedding: Buffer | null; pdf_blob: Buffer | null; pdf_filename: string | null; resume_tex: string | null }
    | undefined;
  if (!r) return false;
  db.prepare(
    `INSERT INTO my_profile (id, raw_text, parsed_json, embedding, pdf_blob, pdf_filename, resume_tex, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       raw_text = excluded.raw_text,
       parsed_json = excluded.parsed_json,
       embedding = excluded.embedding,
       pdf_blob = excluded.pdf_blob,
       pdf_filename = excluded.pdf_filename,
       resume_tex = excluded.resume_tex,
       updated_at = CURRENT_TIMESTAMP`
  ).run(r.raw_text, r.parsed_json, r.embedding, r.pdf_blob, r.pdf_filename, r.resume_tex);
  return true;
}

/** Make a resume the active one (exclusive) and mirror it into my_profile. */
export function setActiveResume(resumeId: number): boolean {
  const exists = db.prepare('SELECT id FROM resumes WHERE id = ?').get(resumeId);
  if (!exists) return false;
  const tx = db.transaction((id: number) => {
    db.prepare('UPDATE resumes SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('UPDATE resumes SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    mirrorResumeToProfile(id);
  });
  tx(resumeId);
  return true;
}

/** The active resume's id, or null. */
export function getActiveResumeId(): number | null {
  const row = db.prepare('SELECT id FROM resumes WHERE is_active = 1 LIMIT 1').get() as { id: number } | undefined;
  return row?.id ?? null;
}
