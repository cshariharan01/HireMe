// Lightweight Markdown -> docx converter for the small subset our LLM emits:
//   # H1, ## H2, ### H3, **bold**, *italic*, "- bullet", plain paragraphs.
// Not a full CommonMark parser — good enough for our resume variants and cover letters.

import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';

interface RunSeg {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

// Parse inline **bold** and *italic* into runs. Greedy left-to-right scan.
function parseInline(line: string): RunSeg[] {
  const out: RunSeg[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2);
      if (end > 0) {
        out.push({ text: line.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    if (line[i] === '*') {
      const end = line.indexOf('*', i + 1);
      if (end > 0) {
        out.push({ text: line.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }
    // grab a chunk of plain text up to the next * or end
    const next = line.indexOf('*', i);
    const stop = next < 0 ? line.length : next;
    if (stop > i) out.push({ text: line.slice(i, stop) });
    i = stop;
  }
  return out;
}

function toRuns(segs: RunSeg[], baseSize = 22): TextRun[] {
  return segs.map((s) => new TextRun({ text: s.text, bold: s.bold, italics: s.italic, size: baseSize }));
}

export async function markdownToDocxBlob(markdown: string, fileName = 'document'): Promise<Blob> {
  const lines = markdown.split('\n');
  const paragraphs: Paragraph[] = [];

  for (let raw of lines) {
    raw = raw.replace(/\r$/, '');
    const trimmed = raw.trim();
    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: '' }));
      continue;
    }

    // Headings
    if (trimmed.startsWith('### ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 80 },
          children: toRuns(parseInline(trimmed.slice(4)), 24),
        })
      );
      continue;
    }
    if (trimmed.startsWith('## ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 280, after: 120 },
          children: toRuns(parseInline(trimmed.slice(3)), 26),
        })
      );
      continue;
    }
    if (trimmed.startsWith('# ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { after: 120 },
          children: toRuns(parseInline(trimmed.slice(2)), 36),
        })
      );
      continue;
    }

    // Bullet
    if (/^[-*]\s+/.test(trimmed)) {
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: toRuns(parseInline(trimmed.replace(/^[-*]\s+/, '')), 22),
        })
      );
      continue;
    }

    // Plain paragraph
    paragraphs.push(
      new Paragraph({
        spacing: { after: 100 },
        children: toRuns(parseInline(trimmed), 22),
      })
    );
  }

  const doc = new Document({
    creator: 'HireSignal',
    title: fileName,
    styles: {
      default: {
        document: { run: { font: 'Calibri' } },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, // 0.5" margins
        children: paragraphs,
      },
    ],
  });

  return Packer.toBlob(doc);
}

// `downloadBlob` moved to `./download-blob` so callers that only need a download don't pull the
// `docx` library in through this module. Re-exported here to keep existing imports working.
export { downloadBlob } from './download-blob';
