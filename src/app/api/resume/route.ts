import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { generateEmbedding, embeddingToBlob, getEmbeddingInfo } from '@/lib/embeddings';
import { assertEmbeddingConsistent, recordEmbeddingSignature } from '@/lib/embedding-signature';
import { parseResume, deriveTargetRoles, deriveDomainTerms } from '@/lib/llm';
import { setActiveResume, getActiveResumeId } from '@/lib/resumes';

// Embedding failures surface as opaque errors — turn them into a clear, provider-aware message.
function friendlyError(e: unknown): { message: string; status: number } {
  const msg = e instanceof Error ? e.message : String(e);
  // Provider-mismatch guard message is already actionable — pass it through as 409 Conflict.
  if (/provider mismatch/i.test(msg)) return { message: msg, status: 409 };
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|11434|embedding|aborted|timeout|HTTP (401|403|429|5\d\d)/i.test(msg)) {
    const { provider, model } = getEmbeddingInfo();
    if (provider === 'ollama') {
      return { message: 'Embedding via Ollama failed or timed out (it may be down or overloaded). Ensure `ollama serve` is running with `nomic-embed-text` pulled, then retry.', status: 503 };
    }
    return { message: `Embedding via ${provider} (${model}) failed: ${msg.slice(0, 140)}. Check EMBEDDING_API_KEY / provider status, then retry.`, status: 503 };
  }
  return { message: msg || 'Failed to process resume', status: 500 };
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 5MB)' }, { status: 400 });
    }

    // Optional label for this resume (multi-resume library). Fallback to filename.
    const rawLabel = (formData.get('label') as string | null)?.trim();
    const fallbackLabel = file.name.replace(/\.pdf$/i, '').slice(0, 60) || 'Resume';

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // pdf-parse v1 tries to run a test on require() — import the inner lib directly
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const pdfData = await pdfParse(buffer);
    const rawText = pdfData.text;

    if (!rawText || rawText.trim().length === 0) {
      return NextResponse.json({ error: 'Could not extract text from PDF' }, { status: 400 });
    }

    const parsedJson = await parseResume(rawText);
    // Guard: refuse to embed into a corpus that used a different provider (would corrupt matching).
    assertEmbeddingConsistent(db);
    const embedding = await generateEmbedding(rawText);
    const embeddingBlob = embeddingToBlob(embedding);

    // Adaptive role targeting — derive resume-fit roles and default them all-on.
    // Non-fatal: if the LLM call fails, the resume still saves (roles stay empty and
    // the user can regenerate from /profile).
    let suggestedRoles: string[] = [];
    try {
      suggestedRoles = await deriveTargetRoles(parsedJson);
    } catch (e) {
      console.warn('[resume] deriveTargetRoles failed:', e instanceof Error ? e.message : e);
    }
    // Adaptive domain targeting — derive the resume's domain vocabulary for the matcher's
    // soft boost (replaces the hardcoded healthcare ontology). Non-fatal like roles.
    let domainTerms: string[] = [];
    try {
      domainTerms = await deriveDomainTerms(parsedJson);
    } catch (e) {
      console.warn('[resume] deriveDomainTerms failed:', e instanceof Error ? e.message : e);
    }
    const enriched = {
      ...parsedJson,
      suggested_roles: suggestedRoles,
      domain_terms: domainTerms,
      targets: { roles: suggestedRoles },
    };

    const label = rawLabel || parsedJson.name || fallbackLabel;

    // Insert into the resume library and make it active (which mirrors it into my_profile).
    // Store the original PDF bytes so the user can submit their real resume, not just the
    // AI-tailored variant.
    const pdfFilename = file.name || `${label}.pdf`;
    const info = db.prepare(
      'INSERT INTO resumes (label, raw_text, parsed_json, embedding, is_active, pdf_blob, pdf_filename) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run(label, rawText, JSON.stringify(enriched), embeddingBlob, buffer, pdfFilename);
    setActiveResume(Number(info.lastInsertRowid));
    recordEmbeddingSignature(db); // first embed establishes the corpus's embedding space

    return NextResponse.json({
      success: true,
      profile: enriched,
      skillCount: enriched.skills.length,
      suggestedRoles,
      domainTerms,
      resumeId: Number(info.lastInsertRowid),
      label,
    });
  } catch (error) {
    console.error('Resume upload error:', error);
    const { message, status } = friendlyError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET() {
  try {
    const profile = db.prepare('SELECT * FROM my_profile WHERE id = 1').get() as {
      raw_text: string;
      parsed_json: string;
      updated_at: string;
    } | undefined;

    if (!profile) {
      return NextResponse.json({ profile: null });
    }

    return NextResponse.json({
      profile: JSON.parse(profile.parsed_json),
      updatedAt: profile.updated_at,
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 });
  }
}

// PATCH: edit contact / metadata fields without re-parsing the PDF.
// Merges the provided fields into the existing parsed_json. Skips embedding refresh
// (these fields aren't in the embedding anyway).
export async function PATCH(request: NextRequest) {
  try {
    const updates = await request.json();
    const allowedKeys = [
      'name',
      'email',
      'phone',
      'linkedin',
      'location',
      'title',
      'targets',
      'street',
      'city',
      'state',
      'country',
      'zipCode',
      'pincode',
      'currentCtcInr',
      'expectedCtcInr',
      'currentSalary',
      'expectedSalary',
      'noticePeriodDays',
      'currentCompany',
      'currentJobTitle',
    ];
    const filtered: Record<string, unknown> = {};
    for (const k of allowedKeys) if (k in updates) filtered[k] = updates[k];

    const existing = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
    if (!existing) return NextResponse.json({ error: 'No profile to update' }, { status: 404 });

    const merged = { ...JSON.parse(existing.parsed_json), ...filtered };
    const mergedJson = JSON.stringify(merged);
    db.prepare(
      `UPDATE my_profile SET parsed_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
    ).run(mergedJson);
    // Persist the edit to the active resume row too, so switching resumes doesn't lose it.
    const activeId = getActiveResumeId();
    if (activeId != null) {
      db.prepare('UPDATE resumes SET parsed_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mergedJson, activeId);
    }

    return NextResponse.json({ success: true, profile: merged });
  } catch (error) {
    console.error('Profile patch error:', error);
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
  }
}
