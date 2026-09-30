// LaTeX résumé lane. When the user uploads their Overleaf/LaTeX TEMPLATE and a LaTeX compiler is
// installed, tailored resumes are produced by LLM-editing that template and compiling the result —
// so the output PDF keeps the user's real résumé design. Without a compiler (or a template) the
// pipeline falls back to the Markdown → HTML renderer unchanged.
//
// NOTE: detection is memoized at module level. Add a compiler to PATH and restart the app (or call
// `clearLatexCompilerCache`) before expecting it to be seen.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

interface ExecError {
  message?: string;
  stdout?: string;
  stderr?: string;
}

let compilerPromise: Promise<string | null> | null = null;

function probeCompiler(cmd: string): Promise<boolean> {
  return execFileAsync(cmd, ['--version'], { timeout: 4000, windowsHide: true })
    .then(() => true)
    .catch(() => false);
}

/** Absolute engine binaries in the standard Windows install locations, tried when PATH misses them. */
function winInstallCandidates(): string[] {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'MiKTeX', 'miktex', 'bin') : '',
    'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
    'C:\\Program Files\\MiKTeX\\miktex\\bin',
    'C:\\Program Files\\MiKTeX 2.9\\miktex\\bin\\x64',
  ].filter(Boolean);
  const out: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const exe of ['pdflatex.exe', 'xelatex.exe']) {
      const full = path.join(root, exe);
      if (fs.existsSync(full)) out.push(full);
    }
  }
  return out;
}

/** The latex engine on PATH (`pdflatex` preferred, `xelatex` as the Unicode-capable fallback). */
export function findLatexCompiler(): Promise<string | null> {
  compilerPromise ??= (async () => {
    const candidates = process.platform === 'win32' ? ['pdflatex', 'xelatex'] : ['pdflatex', 'xelatex'];
    for (const cmd of candidates) {
      if (await probeCompiler(cmd)) return cmd;
    }
    // MiKTeX installs into a per-user dir that only NEW terminals see on PATH. If this server was
    // started from an old window, `pdflatex` resolves as "not found" even though it's installed —
    // probe the absolute install paths as a last resort before giving up.
    for (const full of winInstallCandidates()) {
      if (await probeCompiler(full)) return full;
    }
    return null;
  })();
  return compilerPromise;
}

/** True when a LaTeX compiler is on PATH (memoized — a brand-new install needs a restart). */
export async function hasLatexCompiler(): Promise<boolean> {
  return (await findLatexCompiler()) !== null;
}

/** Forget the memoized compiler check (used when the user installs TeX without restarting). */
export function clearLatexCompilerCache(): void {
  compilerPromise = null;
}

/**
 * Compile a complete .tex document to PDF bytes using the discovered engine. Throws with a
 * readable compiler message on failure. Temporary directory is fully cleaned up afterwards.
 */
export async function compileLatex(tex: string, timeoutMs = 120_000): Promise<Buffer> {
  const compiler = await findLatexCompiler();
  if (!compiler) throw new Error('No LaTeX compiler found on PATH — install MiKTeX or TeX Live, or restart the app after installing.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-latex-'));
  try {
    fs.writeFileSync(path.join(dir, 'main.tex'), tex, 'utf8');
    const args = [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      `-output-directory=${dir}`,
      'main.tex',
    ];
    try {
      await execFileAsync(compiler, args, { timeout: timeoutMs, windowsHide: true, cwd: dir });
    } catch (e) {
      const err = e as ExecError;
      const tail = (err.stderr || err.stdout || err.message || 'unknown error').slice(0, 600).trim();
      throw new Error(`LaTeX compilation failed: ${tail}`);
    }
    const pdfPath = path.join(dir, 'main.pdf');
    if (!fs.existsSync(pdfPath)) throw new Error('LaTeX reported success but produced no PDF.');
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A resume template is usable only if it looks like a real LaTeX document. */
export function looksLikeLatexTemplate(tex: string | null | undefined): boolean {
  if (!tex || !tex.trim()) return false;
  return /\\documentclass/.test(tex) && /\\end\{document\}/.test(tex);
}

/**
 * Compile a .tex document, and if that fails hand the compiler's error to `repair` for ONE
 * regeneration pass (balanced braces/environments, macro arguments restored) before compiling the
 * result. Returns `{ bytes, tex }` where `tex` is the document that actually compiled — callers
 * cache THAT, not the raw model output, so a broken draft never poisons the job cache again.
 * Throws (the original failure) if the repair attempt also cannot be compiled.
 */
export async function compileLatexWithRepair(
  texToTry: string,
  repair: (compileError: string) => Promise<string>,
  timeoutMs = 120_000,
): Promise<{ bytes: Buffer; tex: string }> {
  let bytes: Buffer;
  try {
    bytes = await compileLatex(texToTry, timeoutMs);
    return { bytes, tex: texToTry };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[latex] compile failed — asking the model to repair structure:', msg.slice(0, 200));
    const repaired = await repair(msg);
    bytes = await compileLatex(repaired, timeoutMs);
    return { bytes, tex: repaired };
  }
}

/**
 * Compile a .tex document and return the number of pages in the resulting PDF.
 * Useful to detect when a tailored resume overflows its template's page budget.
 */
export async function getLatexPageCount(tex: string, timeoutMs = 120_000): Promise<number> {
  const bytes = await compileLatex(tex, timeoutMs);
  // pdf-parse v1 tries to run a test on require() — import the inner lib directly
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(bytes);
  return data.numpages as number;
}

/**
 * Compile a .tex document and, if the resulting PDF exceeds `targetPages`, automatically
 * shrink it to fit by progressively applying less-destructive interventions:
 *
 *   1. Font size:       12pt → 11pt → 10pt
 *   2. Itemize spacing: add `\setlist[itemize]{itemsep=0pt,topsep=0pt,parsep=0pt}`
 *   3. Section spacing: add `\titlespacing*{\section}{0pt}{3pt}{1pt}` and variants
 *   4. Page height:     add `\enlargethispage{2\baselineskip}`
 *
 * Returns `{ bytes, tex }` of the final fitted document. Throws only if the document fails to
 * compile even at the smallest settings (which normally means a structural LaTeX error, not overflow).
 */
export async function fitLatexToPageBudget(
  tex: string,
  targetPages: number,
  timeoutMs = 120_000,
): Promise<{ bytes: Buffer; tex: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');

  async function pageCount(t: string): Promise<number> {
    const buf = await compileLatex(t, timeoutMs);
    const data = await pdfParse(buf);
    return data.numpages as number;
  }

  // Initial compile — fast-path: already fits
  let bytes = await compileLatex(tex, timeoutMs);
  let currentTex = tex;
  const data = await pdfParse(bytes);
  if (data.numpages <= targetPages) {
    console.log(`[latex] fit: already ${data.numpages} pages (target=${targetPages})`);
    return { bytes, tex: currentTex };
  }
  console.log(`[latex] fit: ${data.numpages} pages > ${targetPages} — attempting auto-fit`);

  // NOTE: Font size is strictly preserved from the template (\documentclass option is never altered).
  // Content length is controlled by LLM prompt rules to match original template word/sentence budget.

  // --- Step 2: Tighten itemize / list spacing ---
  const ITEMIZE_SPACING = '\\setlist[itemize]{itemsep=0pt,topsep=0pt,parsep=0pt,partopsep=0pt}';
  if (!currentTex.includes(ITEMIZE_SPACING)) {
    // Inject after \usepackage{enumitem} or just before \begin{document}
    let injected = currentTex.replace(
      /(\\usepackage(?:\[[^\]]*\])?\{enumitem\})/,
      `$1\n${ITEMIZE_SPACING}`,
    );
    if (injected === currentTex) {
      injected = currentTex.replace('\\begin{document}', `${ITEMIZE_SPACING}\n\\begin{document}`);
    }
    try {
      const pages = await pageCount(injected);
      console.log(`[latex] fit: tight itemize → ${pages} pages`);
      if (pages <= targetPages) {
        bytes = await compileLatex(injected, timeoutMs);
        return { bytes, tex: injected };
      }
      currentTex = injected;
    } catch (e) {
      console.warn('[latex] fit: tight itemize compile failed —', (e as Error).message.slice(0, 100));
    }
  }

  // --- Step 3: Tighten section / subsection spacing ---
  const SECTION_SPACING =
    '\\titlespacing*{\\section}{0pt}{3pt}{1pt}\n\\titlespacing*{\\subsection}{0pt}{2pt}{1pt}\n\\titlespacing*{\\subsubsection}{0pt}{2pt}{1pt}';
  if (!currentTex.includes('\\titlespacing*{\\section}')) {
    const injected = currentTex.replace('\\begin{document}', `${SECTION_SPACING}\n\\begin{document}`);
    try {
      const pages = await pageCount(injected);
      console.log(`[latex] fit: tight titlespacing → ${pages} pages`);
      if (pages <= targetPages) {
        bytes = await compileLatex(injected, timeoutMs);
        return { bytes, tex: injected };
      }
      currentTex = injected;
    } catch (e) {
      console.warn('[latex] fit: tight titlespacing compile failed —', (e as Error).message.slice(0, 100));
    }
  }

  // --- Step 3.5: Micro-adjust line leading (\linespread{0.95}) ---
  let injectedLinespread = currentTex;
  if (currentTex.includes('\\linespread')) {
    injectedLinespread = currentTex.replace(/\\linespread\{[^}]+\}/, '\\linespread{0.94}');
  } else {
    injectedLinespread = currentTex.replace('\\begin{document}', '\\linespread{0.95}\\selectfont\n\\begin{document}');
  }
  if (injectedLinespread !== currentTex) {
    try {
      const pages = await pageCount(injectedLinespread);
      console.log(`[latex] fit: micro linespread → ${pages} pages`);
      if (pages <= targetPages) {
        bytes = await compileLatex(injectedLinespread, timeoutMs);
        return { bytes, tex: injectedLinespread };
      }
      currentTex = injectedLinespread;
    } catch (e) {
      console.warn('[latex] fit: micro linespread compile failed —', (e as Error).message.slice(0, 100));
    }
  }

  // --- Step 4: Enlarge page by 2-3 baseline skips (minimal margin change) ---
  const ENLARGE = '\\enlargethispage{3\\baselineskip}';
  if (!currentTex.includes('\\enlargethispage')) {
    const injected = currentTex.replace('\\begin{document}', `${ENLARGE}\n\\begin{document}`);
    try {
      const pages = await pageCount(injected);
      console.log(`[latex] fit: enlargethispage → ${pages} pages`);
      if (pages <= targetPages) {
        bytes = await compileLatex(injected, timeoutMs);
        return { bytes, tex: injected };
      }
      currentTex = injected;
    } catch (e) {
      console.warn('[latex] fit: enlargethispage compile failed —', (e as Error).message.slice(0, 100));
    }
  }

  // --- Step 5: Content Trimming (Progressively trim excess bullets to strictly enforce target page budget) ---
  console.log(`[latex] fit: content still ${await pageCount(currentTex)} pages > ${targetPages} — progressively trimming excess bullets...`);
  let trimAttempts = 0;
  while (trimAttempts < 10) {
    trimAttempts++;
    const trimmed = trimLastLatexItem(currentTex);
    if (trimmed === currentTex) break; // no more items to trim safely
    try {
      const pages = await pageCount(trimmed);
      console.log(`[latex] fit: trim bullet #${trimAttempts} → ${pages} pages`);
      currentTex = trimmed;
      if (pages <= targetPages) {
        bytes = await compileLatex(currentTex, timeoutMs);
        return { bytes, tex: currentTex };
      }
    } catch (e) {
      console.warn('[latex] fit: trim bullet failed to compile —', (e as Error).message.slice(0, 100));
      break;
    }
  }

  // Final fallback compile
  bytes = await compileLatex(currentTex, timeoutMs);
  return { bytes, tex: currentTex };
}

/**
 * Trim the last bullet point (\item or \resumeItem) from the body of a .tex document.
 * Safely guards against emptying any section (e.g. Certifications) or project heading:
 * an item list with <= 1 item will NEVER have its last bullet removed.
 */
export function trimLastLatexItem(tex: string): string {
  function trimOneFromSegment(segment: string): string {
    const lines = segment.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      if (!/^\s*\\(?:resumeItem|item)\b/.test(lines[i])) continue;

      // Find boundaries of enclosing list environment
      let envStart = -1;
      let envEnd = -1;

      for (let j = i; j >= 0; j--) {
        if (/\\begin\{(itemize|enumerate)\}|\\resumeItemListStart/.test(lines[j])) {
          envStart = j;
          break;
        }
      }

      for (let j = i; j < lines.length; j++) {
        if (/\\end\{(itemize|enumerate)\}|\\resumeItemListEnd/.test(lines[j])) {
          envEnd = j;
          break;
        }
      }

      if (envStart !== -1 && envEnd !== -1 && envEnd >= envStart) {
        let count = 0;
        for (let k = envStart; k <= envEnd; k++) {
          if (/^\s*\\(?:resumeItem|item)\b/.test(lines[k])) {
            count++;
          }
        }

        // SAFETY GUARD: Do NOT trim if list has <= 1 item left!
        // Preserves sections like Certifications and individual projects from being emptied.
        if (count <= 1) {
          continue;
        }
      }

      let endIdx = i;
      let openBraces = 0;
      for (let j = i; j < lines.length; j++) {
        const line = lines[j];
        for (const ch of line) {
          if (ch === '{') openBraces++;
          if (ch === '}') openBraces--;
        }
        endIdx = j;
        if (openBraces <= 0 && j >= i) break;
      }

      lines.splice(i, endIdx - i + 1);
      let res = lines.join('\n');
      return res.replace(/\\begin\{(itemize|enumerate)\}\s*\\end\{\1\}/g, '');
    }

    return segment;
  }

  if (tex.includes('\\switchcolumn')) {
    const parts = tex.split('\\switchcolumn');
    // Trim Column 1 (Left main column) first if possible
    const col1Trimmed = trimOneFromSegment(parts[0]);
    if (col1Trimmed !== parts[0]) {
      return col1Trimmed + '\\switchcolumn' + parts.slice(1).join('\\switchcolumn');
    }
    // If Column 1 has no trim candidates, trim Column 2 (Right sidebar column)
    const col2Trimmed = trimOneFromSegment(parts.slice(1).join('\\switchcolumn'));
    return parts[0] + '\\switchcolumn' + col2Trimmed;
  } else {
    return trimOneFromSegment(tex);
  }
}



/** Split a .tex doc at the document body markers. Safe for documents missing either marker. */
export function splitLatexDocument(tex: string): {
  preamble: string;
  body: string;
  hasBegin: boolean;
  hasEnd: boolean;
} {
  const begin = tex.indexOf('\\begin{document}');
  const end = tex.lastIndexOf('\\end{document}');
  const hasBegin = begin !== -1;
  const hasEnd = end !== -1;
  const preamble = hasBegin ? tex.slice(0, begin) : '';
  const start = hasBegin ? begin + '\\begin{document}'.length : 0;
  const body = hasEnd ? tex.slice(start, end) : hasBegin ? tex.slice(start) : tex;
  return { preamble, body, hasBegin, hasEnd };
}

/**
 * Normalize a raw .tex body so `pdflatex` (non-UTF8 by default unless inputenc is loaded) can eat
 * it: smart quotes / dashes / unicode punctuation become TeX-safe forms, everything else non-ASCII
 * is dropped. A weak model will happily emit UTF-8 — which is why tailored output must pass through
 * here before compiling, or the whole document dies on a stray em-dash byte.
 *
 * The `%` handling is deliberately CONTEXT-SENSITIVE: a literal percent in prose ("30% faster") is a
 * TeX comment delimiter even inside {...}, so it must be escaped — but the template's OWN comment
 * lines (`%----------HEADING----------`, trailing `% <-- FIX`) must survive unchanged or the PDF
 * starts printing "comments" as text. A `%` whose previous char is a word/digit/closing bracket is
 * prose; any other `%` (line-start, after a space or `}`) begins a comment and is left untouched.
 */
export function sanitizeLatexText(input: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/[\u2014\u2013]/g, '---'],       // em/en dash -> TeX dash
    [/[\u2018\u2019]/g, "'"],          // curly single quotes
    [/[\u201C\u201D]/g, `''`],         // curly double quotes -> TeX ' '
    [/[ \t]*---[ \t]*/g, ' --- '],
    [/[\u2026]/g, '...'],
    [/[\u2022\u2023\u25E6]/g, '-'],    // bullets
    [/[\u00B0]/g, '\\textdegree{}'],
    [/[\u00A0\u200B]/g, ' '],          // nbsp / zero-width space
  ];
  const outLines: string[] = [];
  for (const line of input.split('\n')) {
    // Locate the first COMMENT-introducing `%` (not prose, not already escaped). Everything from it
    // to end-of-line must be preserved verbatim — it is the template's own LaTeX comment.
    let commentIdx = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      if (line[i - 1] === '\\') continue; // already escaped \% — prose
      const prev = i === 0 ? '' : line[i - 1];
      if (/[\w)\]]/.test(prev)) continue; // "...30%" or "...}50%" — prose percentage
      commentIdx = i; // line-start / after space / after } — a comment
      break;
    }
    let prefix = commentIdx === -1 ? line : line.slice(0, commentIdx);
    let suffix = commentIdx === -1 ? '' : line.slice(commentIdx);
    for (const [re, sub] of replacements) prefix = prefix.replace(re, sub);
    // Escaping is idempotent-safe: `\` before `%`/`&` already prevents matching.
    prefix = prefix.replace(/(?<!\\)%/g, '\\%');
    prefix = prefix.replace(/(?<!\\)&/g, '\\&');
    prefix = prefix.replace(/[^\x00-\x7F]/g, ' ');
    suffix = suffix.replace(/[^\x00-\x7F]/g, ' ');
    outLines.push(prefix + suffix);
  }
  return outLines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Extract `{macroName -> declaredArgCount}` from `\newcommand{\name}[N]{...}` definitions. These
 * are the design's OWN custom macros, so a weak model's invocation of them can be validated.
 */
function macroArities(designTex: string): Map<string, number> {
  const map = new Map<string, number>();
  const re = /\\newcommand\{?\\([A-Za-z]+)\}?\[\s*(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(designTex))) map.set(m[1], parseInt(m[2], 10));
  return map;
}

/**
 * Top-level `{...}` brace groups that are the macro's OWN arguments, starting at `from` (offset of
 * the invocation's first argument opening brace). Scanning stops at the first non-`{` (non-space)
 * character at depth 0 — i.e. the moment content stops being brace-grouped, like a `\resumeItem`
 * following a `\resumeProjectHeading`. Returns `{start, end, text}` spans so the caller can inspect
 * AND reorder arguments. Stops early on unbalanced braces — the compiler/LLM repair handles those.
 */
function topLevelGroups(text: string, from: number): { start: number; end: number; text: string }[] {
  const groups: { start: number; end: number; text: string }[] = [];
  let depth = 0;
  let start = -1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push({ start, end: i + 1, text: text.slice(start, i + 1) });
        start = -1;
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (j >= text.length || text[j] !== '{') break; // argument list ended
        i = j - 1; // resume at the next `{` (the for-loop will advance past it)
      }
      if (depth < 0) return groups;
    }
  }
  return groups;
}

/**
 * Deterministic repair for the #1 weak-model failure mode: emitting the template's custom section
 * macros with MISSING arguments. `\resumeProjectHeading` takes `{title}{date}`, `\resumeSubheading`
 * takes `{title}{dates}{company}{location}` — a small model routinely drops the date/company group,
 * which shifts everything after it into a wrong argument and kills the compile with "Extra }, or
 * forgotten \endgroup". For every defined macro invoked with fewer groups than its arity, pad the
 * missing `{}` AFTER the last present group (never before — padding early pushes the title into
 * argument #2, which the heading macros render RIGHT-aligned + bold). Also normalizes an already
 * mangled leading `{}` leftward (the shape an old pad-before bug produced) so titles sit in the
 * LEFT column again. Never touches text content.
 */
export function repairMacroArguments(body: string, arieties: Map<string, number>): string {
  let out = body;
  for (const [macro, arity] of arieties) {
    if (arity <= 0) continue;
    // Negative lookahead distinguishes `\resumeItem` from `\resumeItemListStart`.
    const re = new RegExp(`\\\\${macro}(?![a-zA-Z])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      let i = m.index + m[0].length;
      while (i < out.length && /\s/.test(out[i])) i++;
      if (out[i] !== '{') continue; // invocation has no arguments — leave it for the compiler path
      const groups = topLevelGroups(out, i);
      if (groups.length === 0) continue;
      // Normalize a leading empty `{}`: an empty title/location group is never intended, so a
      // `{}{title}` invocation is a mangled `{title}{}` — drop the empty lead and pad back at the end.
      const emptyLead = groups[0].end - groups[0].start === 2 && groups.length >= 2;
      const present = emptyLead ? groups.slice(1) : groups;
      if (present.length > arity) continue; // over-argumented — not ours to fix, leave for the compiler path
      const missing = arity - present.length;
      if (missing === 0 && !emptyLead) continue; // well-formed invocation — leave it alone
      const expected = '{}'.repeat(missing);
      const rebuilt = present.map((g) => g.text).join('') + expected;
      const spanStart = groups[0].start;
      const spanEnd = present[present.length - 1].end;
      console.log(
        `[latex] repaired \\${macro}: ${groups.length} of ${arity} args present, reordered to ${present.length} + pad ${missing}`,
      );
      out = out.slice(0, spanStart) + rebuilt + out.slice(spanEnd);
      re.lastIndex = spanStart + rebuilt.length;
    }
  }
  return out;
}
/**
 * Rebuild the ORIGINAL template's preamble (the design the user chose) with the LLM's NEW content
 * spliced into the body. The model is never trusted to reproduce `\documentclass`/`\usepackage` —
 * it edits facts, not layout. Falls back to a plain article doc if the template has no body
 * markers (which `looksLikeLatexTemplate` normally prevents).
 *
 * The body then gets the deterministic `repairMacroArguments` pass: the design's OWN custom macros
 * (`\resumeProjectHeading`, `\resumeSubheading`, …) declare their arity in `\newcommand`, so any
 * invocation the model emits short of that arity is padded with `{}`. A weak local model will
 * otherwise drop the `{date}` group and every following line shifts into the wrong argument.
 */
function fixPreambleMacros(preamble: string): string {
  let p = preamble;
  // Upgrade \resumeProjectHeading to use tabularx with @{}X r@{} so long project titles & tech stacks wrap cleanly.
  // Note: Use \linewidth instead of \textwidth so tables fit within paracol 2-column layouts without massive gaps!
  p = p.replace(
    /\\newcommand\{\\resumeProjectHeading\}\[2\]\{[\s\S]*?\\end\{tabular\*\}\s*(?:\\vspace\{[^}]+\})?\s*\}/g,
    `\\newcommand{\\resumeProjectHeading}[2]{\n    \\item\n    \\begin{tabularx}{\\linewidth}{@{}X r@{}}\n      \\small#1 & \\textbf{\\small #2}\\\\\n    \\end{tabularx}\\vspace{-6pt}\n}`
  );
  // Upgrade \resumeSubheading to use tabularx with @{}X r@{}
  p = p.replace(
    /\\newcommand\{\\resumeSubheading\}\[4\]\{[\s\S]*?\\end\{tabular\*\}\s*(?:\\vspace\{[^}]+\})?\s*\}/g,
    `\\newcommand{\\resumeSubheading}[4]{\n  \\vspace{-2pt}\\item\n    \\begin{tabularx}{\\linewidth}{@{}X r@{}}\n      \\textbf{#1} & \\textbf{\\small #2} \\\\\n      \\textit{\\small#3} & \\textit{\\small #4} \\\\\n    \\end{tabularx}\\vspace{-6pt}\n}`
  );
  if (!p.includes('\\usepackage{tabularx}')) {
    p = p + '\n\\usepackage{tabularx}\n';
  }
  return p;
}

export function autoCloseLatex(body: string): string {
  let text = body;

  // 1. Balance braces
  let openBraces = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && (i === 0 || text[i - 1] !== '\\')) openBraces++;
    else if (text[i] === '}' && (i === 0 || text[i - 1] !== '\\')) openBraces--;
  }
  if (openBraces > 0) {
    text += '}'.repeat(openBraces);
  }

  // 2. Balance custom resume list macros
  const startItemMatches = (text.match(/\\resumeItemListStart/g) || []).length;
  const endItemMatches = (text.match(/\\resumeItemListEnd/g) || []).length;
  if (startItemMatches > endItemMatches) {
    text += '\n\\resumeItemListEnd'.repeat(startItemMatches - endItemMatches);
  }

  const startSubMatches = (text.match(/\\resumeSubHeadingListStart/g) || []).length;
  const endSubMatches = (text.match(/\\resumeSubHeadingListEnd/g) || []).length;
  if (startSubMatches > endSubMatches) {
    text += '\n\\resumeSubHeadingListEnd'.repeat(startSubMatches - endSubMatches);
  }

  // 3. Balance standard environments if any
  for (const env of ['itemize', 'enumerate', 'tabularx', 'tabular*', 'paracol']) {
    const beginCount = (text.match(new RegExp(`\\\\begin\\{${env}\\}`, 'g')) || []).length;
    const endCount = (text.match(new RegExp(`\\\\end\\{${env}\\}`, 'g')) || []).length;
    if (beginCount > endCount) {
      text += `\n\\end{${env}}`.repeat(beginCount - endCount);
    }
  }

  return text;
}

/**
 * Format experience mentions in resume summary (e.g. "3.6 years", "3 years")
 * dynamically to "3+ years" when candidate's YOE is a decimal / fractional value > N.
 */
export function formatYoeInSummary(texOrMd: string, yoe?: number | null): string {
  if (!texOrMd || yoe == null || isNaN(yoe) || yoe <= 0) return texOrMd;
  const floorVal = Math.floor(yoe);
  const formatted = `${floorVal}+`;
  const pattern = new RegExp(`\\b(${yoe}|${floorVal}(?:\\.\\d+)?)\\s*\\+?\\s*(years?|yrs?)\\b`, 'gi');
  return texOrMd.replace(pattern, `${formatted} $2`);
}

export function spliceLatexContent(designTex: string, modelText: string): string {
  const design = splitLatexDocument(designTex);
  const model = splitLatexDocument(modelText);
  let body = model.body.trim();
  // Strip accidental code fences the model wraps around its output.
  body = body.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```\s*$/i, '');
  body = sanitizeLatexText(body);
  const fixedPreamble = fixPreambleMacros(design.preamble);

  // Deterministically preserve the candidate's original heading block (everything before the first \section)
  // so name, profile title (e.g. "Business Analyst"), and contact info remain untouched.
  const origSecIdx = design.body.search(/\\section\*?\{/);
  const tailSecIdx = body.search(/\\section\*?\{/);
  if (origSecIdx !== -1 && tailSecIdx !== -1) {
    const origHeader = design.body.slice(0, origSecIdx);
    body = origHeader + body.slice(tailSecIdx);
  }

  // Preserve 2-column \begin{paracol} & \switchcolumn structure if template used paracol but model output dropped \switchcolumn
  if (design.body.includes('\\switchcolumn') && !body.includes('\\switchcolumn')) {
    const switchIdx = design.body.indexOf('\\switchcolumn');
    const col2StartSec = design.body.slice(switchIdx).search(/\\section\*?\{/);
    if (col2StartSec !== -1) {
      const col2FirstSecName = design.body.slice(switchIdx + col2StartSec).match(/\\section\*?\{([^}]+)\}/);
      if (col2FirstSecName && col2FirstSecName[1]) {
        const secRegex = new RegExp(`\\\\section\\*?\\{${col2FirstSecName[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'i');
        const matchIdx = body.search(secRegex);
        if (matchIdx !== -1) {
          body = body.slice(0, matchIdx) + '\\switchcolumn\n' + body.slice(matchIdx);
        }
      }
    }
  }

  body = repairMacroArguments(body, macroArities(fixedPreamble));
  body = autoCloseLatex(body);
  if (!design.hasBegin && !design.hasEnd) {
    return `\\documentclass[11pt,letterpaper]{article}\n\\usepackage{fullpage}\n\\usepackage{tabularx}\n\\begin{document}\n${body}\n\\end{document}`;
  }
  const open = design.hasBegin ? '\\begin{document}' : '\\begin{document}';
  return `${fixedPreamble}\n${open}\n${body}\n\\end{document}`;
}

/**
 * Detect whether a cached LaTeX resume variant is from the pre-experience-tailoring era
 * (i.e. contains the unmodified raw tools line from the base template).
 */
export function isStaleTailoredTex(tex: string | null | undefined, baseTex: string | null | undefined): boolean {
  if (!tex || !baseTex) return false;

  // 1. If cached tex contains legacy test strings when not present in baseTex:
  const legacyStrings = ['Hariharan Subramaniyan', 'Data Engineer with 3+ years of experience in ETL'];
  for (const s of legacyStrings) {
    if (tex.includes(s) && !baseTex.includes(s)) {
      return true;
    }
  }

  // 2. If the cached tex has the exact unmodified base tools line:
  const defaultToolsMatch = baseTex.match(/\\textbf\{Tools Used:\}\s*([^\}]+)\}/);
  if (defaultToolsMatch && defaultToolsMatch[1]) {
    const defaultToolsStr = defaultToolsMatch[1].trim();
    if (tex.includes(defaultToolsStr)) {
      return true;
    }
  }

  // 3. Compare preambles: if the candidate's base template preamble has changed in /profile, cached tex is stale
  const cachedPreamble = splitLatexDocument(tex).preamble.replace(/\s+/g, '');
  const basePreamble = splitLatexDocument(baseTex).preamble.replace(/\s+/g, '');
  if (cachedPreamble && basePreamble && cachedPreamble !== basePreamble) {
    return true;
  }

  // 4. Compare heading block (content before first \section): if title was mutated in cached tex, mark as stale
  const baseSecIdx = splitLatexDocument(baseTex).body.search(/\\section\*?\{/);
  const texSecIdx = splitLatexDocument(tex).body.search(/\\section\*?\{/);
  if (baseSecIdx !== -1 && texSecIdx !== -1) {
    const baseHeader = splitLatexDocument(baseTex).body.slice(0, baseSecIdx).replace(/\s+/g, '');
    const texHeader = splitLatexDocument(tex).body.slice(0, texSecIdx).replace(/\s+/g, '');
    if (baseHeader !== texHeader) {
      return true;
    }
  }

  // 5. Check for empty sections or headings with 0 items (damaged by legacy over-trimming)
  const sectionHeadings = tex.match(/\\section\*?\{[^}]+\}/g) || [];
  for (const heading of sectionHeadings) {
    const idx = tex.indexOf(heading);
    const rest = tex.slice(idx + heading.length);
    const nextSecIdx = rest.search(/\\section\*?\{|\\end\{paracol\}|\\end\{document\}/);
    const sectionBody = nextSecIdx !== -1 ? rest.slice(0, nextSecIdx) : rest;
    if (
      heading.toLowerCase().includes('certification') ||
      heading.toLowerCase().includes('skill') ||
      heading.toLowerCase().includes('education') ||
      heading.toLowerCase().includes('experience')
    ) {
      if (!/\\(?:resumeItem|item)\b/.test(sectionBody)) {
        console.log(`[latex] isStaleTailoredTex: heading ${heading} has no items — marking stale for re-tailoring`);
        return true;
      }
    }
  }

  return false;
}

/** Safe PDF filename matching the candidate's original uploaded resume or real name. Never mentions 'Tailored'. */
export function latexPdfFilename(name: string | null | undefined, preferredFilename?: string | null): string {
  if (preferredFilename && preferredFilename.trim()) {
    const clean = preferredFilename.trim().replace(/_?tailored_?/i, '_').replace(/__+/g, '_');
    return clean.endsWith('.pdf') ? clean : `${clean}.pdf`;
  }
  return `${(name || 'candidate').replace(/[^\w-]+/g, '_')}_Resume.pdf`;
}

/**
 * Builds a clean, compilable base LaTeX template populated EXCLUSIVELY with the candidate's
 * parsed profile facts (name, contact, skills, experience, education). Used when no custom
 * template was pasted or to replace legacy/hardcoded test templates.
 */
export function buildLatexTemplateFromProfile(p: Record<string, any>): string {
  const name = sanitizeLatexText(p.name || 'Candidate');
  const title = sanitizeLatexText(p.title || 'Professional');
  const email = p.email ? sanitizeLatexText(p.email) : '';
  const phone = p.phone ? sanitizeLatexText(p.phone) : '';
  const location = p.location ? sanitizeLatexText(p.location) : '';
  const linkedin = p.linkedin ? sanitizeLatexText(p.linkedin) : '';

  const skills: string[] = Array.isArray(p.skills) ? p.skills.map((s: string) => sanitizeLatexText(String(s))) : [];
  const experience: string[] = Array.isArray(p.experience) ? p.experience : [];
  const education: string[] = Array.isArray(p.education) ? p.education.map((e: string) => sanitizeLatexText(String(e))) : [];

  let expSection = '';
  if (experience.length > 0) {
    expSection = '\\section{Experience}\n\\resumeSubHeadingListStart\n';
    for (const item of experience) {
      const parts = String(item).split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      const header = sanitizeLatexText(parts[0]);
      const match = header.match(/^(.*?)(?:\s+at\s+|\s*@\s*|\s*,\s*)(.*?)(?:\s*\((.*?)\))?$/);
      let roleTitle = header;
      let company = '';
      let dates = '';
      if (match) {
        roleTitle = match[1].trim() || header;
        company = match[2].trim() || '';
        dates = match[3] ? match[3].trim() : '';
      }
      expSection += `  \\resumeSubheading\n    {${roleTitle}}{${dates}}\n    {${company}}{}\n    \\resumeItemListStart\n`;
      const bullets = parts.slice(1);
      if (bullets.length > 0) {
        for (const bullet of bullets) {
          expSection += `      \\resumeItem{${sanitizeLatexText(bullet)}}\n`;
        }
      } else {
        expSection += `      \\resumeItem{${roleTitle} responsibilities and key deliverables.}\n`;
      }
      expSection += '    \\resumeItemListEnd\n';
    }
    expSection += '\\resumeSubHeadingListEnd\n';
  }

  let skillsSection = '';
  if (skills.length > 0) {
    skillsSection = `\\section{Skills}\n\\textbf{Technical \\& Professional Skills:}\n\\begin{itemize}\n  \\item ${skills.join(', ')}\n\\end{itemize}\n`;
  }

  let eduSection = '';
  if (education.length > 0) {
    eduSection = '\\section{Education}\n\\resumeSubHeadingListStart\n';
    for (const edu of education) {
      eduSection += `  \\resumeSubheading\n    {${edu}}{}{}{}\n`;
    }
    eduSection += '\\resumeSubHeadingListEnd\n';
  }

  const contactItems = [
    phone ? `\\faPhone\\ ${phone}` : '',
    email ? `\\href{mailto:${email}}{\\faEnvelope\\ \\underline{${email}}}` : '',
    linkedin ? `\\href{${linkedin}}{\\faLinkedin\\ \\underline{LinkedIn}}` : '',
    location ? `\\faMapMarker\\ ${location}` : '',
  ].filter(Boolean);

  const contactLine = contactItems.join(' ~ ');

  return `%-------------------------
% Resume in Latex - ${name}
%------------------------

\\documentclass[letterpaper,11pt]{article}

\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{fontawesome5}
\\usepackage{multicol}
\\usepackage{xcolor}
\\definecolor{richblack}{RGB}{10, 10, 10}
\\AtBeginDocument{\\color{richblack}}
\\setlength{\\multicolsep}{-3.0pt}
\\setlength{\\columnsep}{-1pt}
\\input{glyphtounicode}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\fancypagestyle{plain}{%
  \\fancyhf{}%
  \\fancyfoot{}%
  \\renewcommand{\\headrulewidth}{0pt}%
  \\renewcommand{\\footrulewidth}{0pt}%
}

\\addtolength{\\oddsidemargin}{-0.6in}
\\addtolength{\\evensidemargin}{-0.5in}
\\addtolength{\\textwidth}{1.19in}
\\addtolength{\\topmargin}{-.7in}
\\addtolength{\\textheight}{1.0in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{
  \\vspace{-6pt}\\scshape\\raggedright\\large\\bfseries
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-5pt}]

\\pdfgentounicode=1

\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-2pt}}}}
\\newcommand{\\resumeSubheading}[4]{
  \\vspace{-2pt}\\item
    \\begin{tabularx}{\\textwidth}{@{}X r@{}}
      \\textbf{#1} & \\textbf{\\small #2} \\\\
      \\textit{\\small#3} & \\textit{\\small #4} \\\\
    \\end{tabularx}\\vspace{-6pt}
}
\\newcommand{\\resumeProjectHeading}[2]{
    \\item
    \\begin{tabularx}{\\textwidth}{@{}X r@{}}
      \\small#1 & \\textbf{\\small #2}\\\\
    \\end{tabularx}\\vspace{-6pt}
}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-8pt}}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.0in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}

\\begin{document}
\\thispagestyle{fancy}

%----------HEADING----------
\\begin{center}
    {\\Huge \\scshape ${name}} \\\\ \\vspace{4pt}
    \\textbf{\\Large \\scshape ${title}} \\\\ \\vspace{4pt}
    \\small ${contactLine}
\\end{center}

%-----------SUMMARY-----------
\\section{Summary}
Dynamic and results-driven ${title} with proven experience across requirement analysis, functional specifications, and solution delivery.

${skillsSection}

${expSection}

${eduSection}

\\end{document}
`;
}