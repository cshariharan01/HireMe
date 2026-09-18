// Minimal Markdown → HTML for our resume / cover-letter Markdown subset.
// Handles: # H1, ## H2, ### H3, **bold**, *italic*, "- bullet", paragraphs, links.
// Output is ATS-safe HTML — single column, semantic tags, no flexbox/grid.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(line: string): string {
  // Order matters: process **bold** before *italic*
  let s = escapeHtml(line);
  // Markdown links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${href}">${text}</a>`);
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic (simple, single * pairs that aren't part of bold)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}

export function markdownToHtmlBody(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inList = false;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length > 0) {
      // GFM-style "soft" line breaks — each newline within a paragraph becomes a <br/>.
      // Without this, the LLM's "**Category:** items..." per-line skill list collapses
      // into one space-joined paragraph and reads as one giant blob.
      out.push(`<p>${paraBuf.map(renderInline).join('<br/>')}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (let raw of lines) {
    raw = raw.replace(/\r$/, '');
    const trimmed = raw.trim();

    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }

    if (trimmed.startsWith('### ')) {
      flushPara();
      closeList();
      out.push(`<h3>${renderInline(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushPara();
      closeList();
      out.push(`<h2>${renderInline(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      flushPara();
      closeList();
      out.push(`<h1>${renderInline(trimmed.slice(2))}</h1>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${renderInline(trimmed.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }

    // Plain paragraph line — accumulate until blank line
    paraBuf.push(trimmed);
  }
  flushPara();
  closeList();

  return out.join('\n');
}

// ATS-safe document template. Single column. Standard fonts. No JS. Inline CSS.
// Designed to parse cleanly through Workday, Greenhouse, Lever, iCIMS resume parsers.
export function wrapInAtsTemplate(bodyHtml: string, title = 'Resume'): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    /* ATS-safe: single column, standard fonts, selectable text, no images/headers/footers.
       Professional treatment: refined type scale, a restrained slate accent on section rules. */
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Calibri', 'Segoe UI', Arial, Helvetica, sans-serif;
      font-size: 10.5pt;
      line-height: 1.42;
      color: #24292f;
      max-width: 7.5in;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    h1 {
      font-size: 23pt;
      margin: 0 0 2pt 0;
      font-weight: 700;
      letter-spacing: 0.01em;
      text-align: center;
      color: #1f2937;
    }
    /* The contact line — first <p> right after the H1 — centered + muted */
    h1 + p {
      text-align: center;
      margin: 0 0 12pt 0;
      color: #475569;
      font-size: 9.5pt;
      letter-spacing: 0.01em;
    }
    h2 {
      font-size: 11pt;
      margin: 13pt 0 5pt 0;
      padding-bottom: 3pt;
      border-bottom: 1.5pt solid #2b3a55;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #2b3a55;
    }
    h3 {
      font-size: 11pt;
      margin: 9pt 0 1pt 0;
      font-weight: 700;
      color: #1f2937;
    }
    /* Dates / role meta line (the italic <em> right under an h3) */
    h3 + p em, h3 + p { color: #475569; font-size: 9.5pt; margin-top: 0; }
    p { margin: 3pt 0; }
    ul {
      margin: 3pt 0 7pt 0;
      padding-left: 16pt;
    }
    li {
      margin: 2pt 0;
      padding-left: 2pt;
    }
    strong { font-weight: 700; color: #1f2937; }
    em { font-style: italic; color: #475569; }
    a { color: #2b3a55; text-decoration: none; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
