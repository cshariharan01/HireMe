import db from '../src/lib/db';
import { extractPostingFacts } from '../src/lib/posting-facts';
import { analyzeSkillFit, buildProfileSkillSet, scoreComposite } from '../src/lib/relevance';
import { findSkills } from '../src/lib/skills-vocab';

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

async function debug() {
  const job = db.prepare('SELECT * FROM job_postings WHERE id = 1000055').get() as any;
  const app = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const stripped = cleanStrip(app.resume_tex);

  const tailoredSkills = findSkills(stripped);
  const profileSkillSet = buildProfileSkillSet(tailoredSkills);

  const fit = analyzeSkillFit({
    jobTitle: job.title || '',
    jobDescription: job.description || '',
    profileSkills: tailoredSkills,
    profileSkillSet,
  });

  console.log('Skill Fit score:', fit.score);
  console.log('Matched skills:', fit.matched);
  console.log('Missing skills:', fit.missing);
  console.log('Missing in title:', fit.missingInTitle);

  // Let's test scoreComposite with various retrieval scores
  for (const retrieval of [0.05, 0.2, 0.5, 0.8, 1.0]) {
    const comp = scoreComposite({
      retrieval,
      skillFit: fit,
      llmScore: null,
      llmRecommendation: null,
      locationScore: 0.1,
      freshnessScore: 0.1,
      legitimacyPenalty: 0,
      dealBreakerHits: [],
      missingMustHaves: [],
      belowCompFloor: false,
      domainHit: false,
      roleTargetHit: true,
      rolePenalty: 0,
    });
    console.log(`With retrieval=${retrieval} -> Composite score: ${comp.score}, parts:`, comp.parts);
  }
}

debug().catch(console.error);
