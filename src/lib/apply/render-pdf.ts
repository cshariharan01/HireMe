// Render a resume Markdown string to an ATS-friendly PDF byte buffer.
// Extracted from src/app/api/jobs/[id]/resume.pdf/route.ts so the auto-apply
// pipeline can reuse it without going through HTTP.

import { chromium, type Browser } from 'playwright';
import { markdownToHtmlBody, wrapInAtsTemplate } from '@/lib/markdown-to-html';

export async function renderResumePdf(markdown: string, customFilename?: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const bodyHtml = markdownToHtmlBody(markdown);
  const candidateName = (markdown.match(/^#\s+(.+)$/m)?.[1] || 'Resume').trim();
  const fullHtml = wrapInAtsTemplate(bodyHtml, `${candidateName} - Resume`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(fullHtml, { waitUntil: 'load' });
    const buf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      preferCSSPageSize: true,
    });
    return {
      bytes: new Uint8Array(buf),
      filename: customFilename || `${candidateName.replace(/[^\w-]+/g, '_')}_Resume.pdf`,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
