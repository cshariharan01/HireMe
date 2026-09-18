import fs from 'fs';
import { compileLatex } from '../src/lib/apply/latex';

function autoCloseLatex(body: string): string {
  let text = body;

  // 1. Balance braces
  let openBraces = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && (i === 0 || text[i - 1] !== '\\')) openBraces++;
    else if (text[i] === '}' && (i === 0 || text[i - 1] !== '\\')) openBraces--;
  }
  if (openBraces > 0) {
    text += '}'.repeat(openBraces);
    console.log(`Auto-closed ${openBraces} unclosed braces.`);
  }

  // 2. Balance custom resume list macros
  const startItemMatches = (text.match(/\\resumeItemListStart/g) || []).length;
  const endItemMatches = (text.match(/\\resumeItemListEnd/g) || []).length;
  if (startItemMatches > endItemMatches) {
    const diff = startItemMatches - endItemMatches;
    text += '\n\\resumeItemListEnd'.repeat(diff);
    console.log(`Auto-closed ${diff} \\resumeItemListEnd.`);
  }

  const startSubMatches = (text.match(/\\resumeSubHeadingListStart/g) || []).length;
  const endSubMatches = (text.match(/\\resumeSubHeadingListEnd/g) || []).length;
  if (startSubMatches > endSubMatches) {
    const diff = startSubMatches - endSubMatches;
    text += '\n\\resumeSubHeadingListEnd'.repeat(diff);
    console.log(`Auto-closed ${diff} \\resumeSubHeadingListEnd.`);
  }

  return text;
}

async function run() {
  const content = fs.readFileSync('scratch/failed-yantran.tex', 'utf8');
  // Remove \end{document} to test the body
  const docEnd = content.indexOf('\\end{document}');
  const body = docEnd !== -1 ? content.slice(0, docEnd) : content;

  const repaired = autoCloseLatex(body) + '\n\\end{document}';
  fs.writeFileSync('scratch/repaired-yantran.tex', repaired, 'utf8');

  try {
    const pdf = await compileLatex(repaired);
    console.log('REPAIR COMPILED SUCCESSFULLY! PDF size:', pdf.length);
  } catch (e: any) {
    console.error('STILL FAILED:', e.message);
  }
}

run();
