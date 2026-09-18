import db from '../src/lib/db';
import { stripLatexToText } from '../src/lib/tailored-score';
import { findSkills } from '../src/lib/skills-vocab';
import { buildProfileSkillSet, analyzeSkillFit } from '../src/lib/relevance';

async function test() {
  const job = db.prepare('SELECT * FROM job_postings WHERE id = 1000055').get() as any;
  const profRow = db.prepare('SELECT parsed_json, resume_tex FROM my_profile WHERE id = 1').get() as any;
  const appRow = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;

  const defaultProfile = JSON.parse(profRow.parsed_json);
  console.log('Default profile skills (from parsed_json):', defaultProfile.skills);

  const tailoredStripped = stripLatexToText(appRow.resume_tex);
  const tailoredSkills = findSkills(tailoredStripped);
  console.log('Tailored skills found in LaTeX resume:', tailoredSkills);

  const baseStripped = stripLatexToText(profRow.resume_tex);
  const baseSkills = findSkills(baseStripped);
  console.log('Base LaTeX skills found in base LaTeX resume:', baseSkills);

  const defaultFit = analyzeSkillFit({
    jobTitle: job.title,
    jobDescription: job.description,
    profileSkills: defaultProfile.skills,
    profileSkillSet: buildProfileSkillSet(defaultProfile.skills),
  });
  console.log('Default skill fit score:', defaultFit.score, 'matched:', defaultFit.matched, 'missing:', defaultFit.missing);

  const tailoredFit = analyzeSkillFit({
    jobTitle: job.title,
    jobDescription: job.description,
    profileSkills: tailoredSkills,
    profileSkillSet: buildProfileSkillSet(tailoredSkills),
  });
  console.log('Tailored skill fit score:', tailoredFit.score, 'matched:', tailoredFit.matched, 'missing:', tailoredFit.missing);
}

test().catch(console.error);
