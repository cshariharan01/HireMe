import { describe, it, expect } from 'vitest';
import {
  looksLikeLatexTemplate,
  findLatexCompiler,
  hasLatexCompiler,
  clearLatexCompilerCache,
  compileLatex,
  latexPdfFilename,
  isStaleTailoredTex,
  sanitizeLatexText,
  splitLatexDocument,
  spliceLatexContent,
} from '@/lib/apply/latex';

/**
 * LaTeX résumé lane. The machine may or may not have pdflatex/xelatex installed — the key contract
 * is DETECTION + graceful fallback: without a compiler `compileLatex` reports a readable error and
 * the pipeline keeps using the Markdown renderer, never the reverse.
 */
describe('latex resume lane', () => {
  it('recognizes a real LaTeX document and rejects non-LaTeX text', () => {
    expect(looksLikeLatexTemplate('\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}')).toBe(true);
    expect(looksLikeLatexTemplate('# Markdown Header\nSome text')).toBe(false);
    expect(looksLikeLatexTemplate('')).toBe(false);
    expect(looksLikeLatexTemplate(null)).toBe(false);
  });

  it('detects the compiler memoized and exposes clear booleans', async () => {
    clearLatexCompilerCache();
    const c1 = await findLatexCompiler();
    const h1 = await hasLatexCompiler();
    expect(typeof h1).toBe('boolean');
    expect(h1).toBe(c1 !== null);

    // Second call hits cache (same pointer/value)
    const c2 = await findLatexCompiler();
    expect(c2).toBe(c1);
  });

  it('compiles a minimal document when a compiler exists, else fails readable', async () => {
    const engine = await findLatexCompiler();
    const minimal = '\\documentclass{article}\\begin{document}Hello World\\end{document}';
    if (engine) {
      const pdf = await compileLatex(minimal);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expect((pdf as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    } else {
      await expect(compileLatex(minimal)).rejects.toThrow(/No LaTeX compiler/i);
    }
  });

  it('produces a safe PDF filename matching candidate name or preferred original filename without "Tailored"', () => {
    expect(latexPdfFilename('Arjun Sharma')).toBe('Arjun_Sharma_Resume.pdf');
    expect(latexPdfFilename('Arjun Sharma', 'Hariharan_Subramaniyan_Resume.pdf')).toBe('Hariharan_Subramaniyan_Resume.pdf');
    expect(latexPdfFilename('')).toContain('candidate');
    expect(latexPdfFilename('A/B:C')).not.toMatch(/[/:]/);
    expect(latexPdfFilename('Arjun Sharma')).not.toContain('Tailored');
  });

  it('detects stale un-tailored LaTeX resume drafts', () => {
    const baseTex = '\\section{Experience}\\resumeItem{\\textbf{Tools Used:} Python, Apache Kafka, Apache Spark, MySQL, ClickHouse, Pentaho}';
    const staleTex = '\\section{Summary}New Summary\\section{Experience}\\resumeItem{\\textbf{Tools Used:} Python, Apache Kafka, Apache Spark, MySQL, ClickHouse, Pentaho}';
    const freshTex = '\\section{Summary}New Summary\\section{Experience}\\resumeItem{\\textbf{Tools Used:} Python, AWS, Snowflake, PySpark, SQL}';

    expect(isStaleTailoredTex(staleTex, baseTex)).toBe(true);
    expect(isStaleTailoredTex(freshTex, baseTex)).toBe(false);
  });

  it('sanitizes model output that would break pdflatex', () => {
    // A literal % is a TeX comment delimiter even inside {…} — "30%\n" swallowed the closing brace
    // and produced "Runaway argument … File ended while scanning use of \resumeItem". It must be
    // escaped. Curly quotes/dashes degenerate to ASCII-safe forms, non-ASCII bytes are dropped.
    const dirty = 'Cut costs by 30% & led 5\u2014person team\u2026 \u201Csmart\u201D \u00E9';
    const clean = sanitizeLatexText(dirty);
    expect(clean).toContain('30\\%');
    expect(clean).not.toContain('30%');
    expect(clean).not.toMatch(/[^\x00-\x7F]/);
    expect(clean).toContain('---');
    expect(clean).toContain('...');
    expect(clean).toContain(`''smart''`);
  });

  it('splices model content into the template body, repairing broken preamble output', () => {
    const design =
      '\\documentclass{article}\n\\usepackage{geometry}\n\\begin{document}\nORIGINAL\n\\end{document}';
    // Hypothetical model output: wrong preamble entirely replaced, stray code fences, UTF-8 dash.
    const model =
      '```latex\n\\documentclass{report}\n\\begin{document}\nNo wait -- \\textbf{Don`t trust the model} 30% \u2014 over.}\n\\end{document}\n```';
    const spliced = spliceLatexContent(design, model);
    // Preamble comes from the TEMPLATE, never the model.
    expect(spliced).toContain('\\usepackage{geometry}');
    expect(spliced).not.toContain('\\documentclass{report}');
    // Model body content is preserved (sanitized).
    expect(spliced).toContain("\\textbf{Don`t trust the model}");
    expect(spliced).toContain('30\\%');
    // Fences are gone; document still opens and closes exactly once.
    expect(spliced).not.toMatch(/```/);
    expect((spliced.match(/\\begin\{document\}/g) || []).length).toBe(1);
    expect((spliced.match(/\\end\{document\}/g) || []).length).toBe(1);
    expect(spliced).not.toContain('ORIGINAL');
  });

  it('splits a document at body markers and tolerates missing ones', () => {
    const doc = 'PRE\n\\begin{document}\nBODY\n\\end{document}\nPOST';
    const parts = splitLatexDocument(doc);
    expect(parts.preamble).toBe('PRE\n');
    expect(parts.body).toBe('\nBODY\n');
    expect(parts.hasBegin).toBe(true);
    expect(parts.hasEnd).toBe(true);
    const bare = splitLatexDocument('nothing here');
    expect(bare.hasBegin).toBe(false);
    expect(bare.hasEnd).toBe(false);
    expect(bare.body).toBe('nothing here');
  });

  it('preserves the template\'s own % comment lines but escapes prose percent signs', () => {
    // Regression: the sanitizer used to escape EVERY % — so the template's real comment lines
    // (e.g. "%----------HEADING----------", "\\thispagestyle{fancy}  % <-- FIX ...") were printed
    // as literal text in the compiled PDF. A comment start stays a comment; "30%" becomes 30\%.
    const body =
      '\\section{Summary}\n' +
      '%----------HEADING----------\n' +
      'Reduced reporting load by 30% and uptime by 15%.\n' +
      '\\thispagestyle{fancy}  % <-- FIX: Apply fancy to first page too\n' +
      '\\resumeItem{Achieved 99.9% availability}\n';
    const clean = sanitizeLatexText(body);
    expect(clean).toContain('%----------HEADING----------');
    expect(clean).toContain('% <-- FIX: Apply fancy to first page too');
    expect(clean).toContain('30\\%');
    expect(clean).toContain('15\\%');
    expect(clean).toContain('99.9\\%');
    expect(clean).not.toMatch(/(\d)%(\s)/);
  });

  it('upgrades rigid tabular* macros to tabularx to prevent text overflow past the margins', () => {
    const oldTemplate = `\\documentclass{article}
\\usepackage{latexsym}
\\newcommand{\\resumeProjectHeading}[2]{
    \\item
    \\begin{tabular*}{1.001\\textwidth}{l@{\\extracolsep{\\fill}}r}
      \\small#1 & #2 \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\begin{document}
Old Content
\\end{document}`;

    const model = 'New tailored content';
    const result = spliceLatexContent(oldTemplate, model);

    expect(result).toContain('\\usepackage{tabularx}');
    expect(result).toContain('\\begin{tabularx}{\\textwidth}{@{}X r@{}}');
    expect(result).not.toContain('1.001\\textwidth');
  });
});