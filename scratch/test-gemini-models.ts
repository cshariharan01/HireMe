import { GoogleGenerativeAI } from '@google/generative-ai';

const key = 'AQ.Ab8RN6I8id9dkvKPT-yBxJY6Tc9VOmqfGRpvRWQUyRIlV-Afqg';
const genAI = new GoogleGenerativeAI(key);

async function test() {
  for (const m of ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-computer-use-preview-10-2025']) {
    try {
      console.log('Trying model:', m);
      const model = genAI.getGenerativeModel({ model: m });
      const r = await model.generateContent('Hi, reply with OK');
      console.log('✓ Model', m, 'SUCCESS:', r.response.text().trim());
      return m;
    } catch (e: any) {
      console.log('✗ Model', m, 'error:', e.message.slice(0, 150));
    }
  }
}
test();
