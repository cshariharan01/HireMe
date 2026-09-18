import db from '../src/lib/db';

function printSections(tex: string, company: string) {
  console.log(`\n================== ${company} ==================`);
  const summaryMatch = tex.match(/\\section\{Summary\}[\s\S]*?(?=\\section)/);
  if (summaryMatch) console.log(summaryMatch[0].trim());
  const skillsMatch = tex.match(/\\section\{Skills\}[\s\S]*?(?=\\section)/);
  if (skillsMatch) console.log(skillsMatch[0].trim());
  const expTools = tex.match(/\\textbf\{Tools Used:\}[^\}\n]+/g);
  if (expTools) console.log('Experience Tools Used:', expTools);
}

const hcl = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 18120').get() as any;
printSections(hcl.resume_tex, 'HCLTech (AWS Data Engineer - 89%)');

const ormae = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 17668').get() as any;
printSections(ormae.resume_tex, 'ORMAE (Lead Data Engineer - 97%)');

const unison = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 17953').get() as any;
printSections(unison.resume_tex, 'Unison Group (Data Engineer - 81%)');

const yantran = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
printSections(yantran.resume_tex, 'Yantran (Data Engineer - Current)');
