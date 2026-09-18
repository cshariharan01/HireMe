import db from '../src/lib/db';

const template = db.prepare('SELECT resume_tex FROM my_profile WHERE id = 1').get() as any;
const app18120 = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 18120').get() as any;
const app18060 = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 18060').get() as any;

console.log('Template length:', template.resume_tex.length);
console.log('App 18120 tex length:', app18120.resume_tex.length);
console.log('App 18060 tex length:', app18060.resume_tex.length);

// Compare differences
console.log('Template skills section:');
const tSkills = template.resume_tex.match(/\\section\{Skills\}[\s\S]*?\\section/);
console.log(tSkills ? tSkills[0].slice(0, 300) : 'Not found');

console.log('App 18120 skills section:');
const aSkills = app18120.resume_tex.match(/\\section\{Skills\}[\s\S]*?\\section/);
console.log(aSkills ? aSkills[0].slice(0, 300) : 'Not found');
