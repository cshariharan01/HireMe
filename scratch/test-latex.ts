import { findLatexCompiler, hasLatexCompiler } from '../src/lib/apply/latex';

async function test() {
  const comp = await findLatexCompiler();
  const has = await hasLatexCompiler();
  console.log('Compiler:', comp, 'Has:', has);
}
test();
