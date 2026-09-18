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
    // Escaping is idempotent-safe: `\` before `%` already prevents matching, `30%` becomes `30\%`.
    prefix = prefix.replace(/(?<!\\)%/g, '\\%');
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
  // Upgrade \resumeProjectHeading to use tabularx with @{}X r@{} so long project titles & tech stacks wrap cleanly
  p = p.replace(
    /\\newcommand\{\\resumeProjectHeading\}\[2\]\{[\s\S]*?\\end\{tabular\*\}\s*(?:\\vspace\{[^}]+\})?\s*\}/g,
    `\\newcommand{\\resumeProjectHeading}[2]{\n    \\item\n    \\begin{tabularx}{\\textwidth}{@{}X r@{}}\n      \\small#1 & \\textbf{\\small #2}\\\\\n    \\end{tabularx}\\vspace{-6pt}\n}`
  );
  // Upgrade \resumeSubheading to use tabularx with @{}X r@{}
  p = p.replace(
    /\\newcommand\{\\resumeSubheading\}\[4\]\{[\s\S]*?\\end\{tabular\*\}\s*(?:\\vspace\{[^}]+\})?\s*\}/g,
    `\\newcommand{\\resumeSubheading}[4]{\n  \\vspace{-2pt}\\item\n    \\begin{tabularx}{\\textwidth}{@{}X r@{}}\n      \\textbf{#1} & \\textbf{\\small #2} \\\\\n      \\textit{\\small#3} & \\textit{\\small #4} \\\\\n    \\end{tabularx}\\vspace{-6pt}\n}`
  );
  if (!p.includes('\\usepackage{tabularx}')) {
    p = p.replace('\\begin{document}', '\\usepackage{tabularx}\n\\begin{document}');
    if (!p.includes('\\usepackage{tabularx}')) {
      p = `\\usepackage{tabularx}\n` + p;
    }
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
  for (const env of ['itemize', 'enumerate', 'tabularx', 'tabular*']) {
    const beginCount = (text.match(new RegExp(`\\\\begin\\{${env}\\}`, 'g')) || []).length;
    const endCount = (text.match(new RegExp(`\\\\end\\{${env}\\}`, 'g')) || []).length;
    if (beginCount > endCount) {
      text += `\n\\end{${env}}`.repeat(beginCount - endCount);
    }
  }

  return text;
}

export function spliceLatexContent(designTex: string, modelText: string): string {
  const design = splitLatexDocument(designTex);
  const model = splitLatexDocument(modelText);
  let body = model.body.trim();
  // Strip accidental code fences the model wraps around its output.
  body = body.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```\s*$/i, '');
  body = sanitizeLatexText(body);
  const fixedPreamble = fixPreambleMacros(design.preamble);
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
  // If the cached tex has the exact unmodified base tools line, it's from the pre-experience-tailoring era
  const defaultToolsMatch = baseTex.match(/\\textbf\{Tools Used:\}\s*([^\}]+)\}/);
  if (defaultToolsMatch && defaultToolsMatch[1]) {
    const defaultToolsStr = defaultToolsMatch[1].trim();
    if (tex.includes(defaultToolsStr)) {
      return true;
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