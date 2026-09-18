/**
 * Trigger a browser download for an in-memory Blob.
 *
 * Lives in its OWN module on purpose. It used to be exported from `markdown-to-docx.ts`, so every
 * caller that only wanted to save a PDF still pulled in the `docx` library (~6MB installed) through
 * that module's import graph — including the job-detail panel, which put it in the dashboard's
 * first-load JS. Keeping this dependency-free means the PDF path costs nothing extra and the docx
 * path can stay behind a dynamic import.
 */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
