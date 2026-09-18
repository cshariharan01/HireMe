import db from '../src/lib/db';
import { getTailoredMatchScore } from '../src/lib/matches';

function cleanStripLatexToText(tex: string): string {
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

async function run() {
  const yApp = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const hApp = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 18120').get() as any;

  console.log('Testing clean stripped text:');
  const hClean = cleanStripLatexToText(hApp.resume_tex);
  console.log('HCLTech clean preview:', hClean.slice(0, 150));
  const hRes = await getTailoredMatchScore(18120, hClean);
  console.log('HCLTech with clean strip -> score:', hRes?.tailoredMatch.score, 'default:', hRes?.defaultMatch?.score);

  const yClean = cleanStripLatexToText(yApp.resume_tex);
  console.log('Yantran clean preview:', yClean.slice(0, 150));
  const yRes = await getTailoredMatchScore(1000055, yClean);
  console.log('Yantran with clean strip -> score:', yRes?.tailoredMatch.score, 'default:', yRes?.defaultMatch?.score);
}

run().catch(console.error);
