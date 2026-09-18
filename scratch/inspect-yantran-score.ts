import db from '../src/lib/db';
import { getTailoredMatchScore } from '../src/lib/matches';

function cleanStrip(tex: string): string {
  const beginIdx = tex.indexOf('\\begin{document}');
  const endIdx = tex.lastIndexOf('\\end{document}');
  let body = tex;
  if (beginIdx !== -1) {
    body = endIdx !== -1 ? tex.slice(beginIdx + '\\begin{document}'.length, endIdx) : tex.slice(beginIdx + '\\begin{document}'.length);
  }
  return body
    .replace(/^%[^\n]*$/gm, '')
    .replace(/\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g, '\n$2\n')
    .replace(/\\resumeSubheading\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g, '$1 $2 $3 $4 ')
    .replace(/\\resumeProjectHeading\{([^}]*)\}\{([^}]*)\}/g, '$1 $2 ')
    .replace(/\\resumeItem\{/g, ' ')
    .replace(/\\[a-zA-Z]+(?:\*|\[[^\]]*\])?(?:\{([^}]*)\})?/g, '$1 ')
    .replace(/[{}\\%&$#_~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function test() {
  const yApp = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const stripped = cleanStrip(yApp.resume_tex);
  const res = await getTailoredMatchScore(1000055, stripped);
  console.log('tailoredMatch score:', res?.tailoredMatch.score);
  console.log('reasons:', JSON.stringify(res?.tailoredMatch.reasons, null, 2));
  console.log('gapAnalysis:', JSON.stringify(res?.tailoredMatch.gapAnalysis, null, 2));
}

test().catch(console.error);
