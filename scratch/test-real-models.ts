import { GoogleGenerativeAI } from '@google/generative-ai';

const key = 'AQ.Ab8RN6I8id9dkvKPT-yBxJY6Tc9VOmqfGRpvRWQUyRIlV-Afqg';
const genAI = new GoogleGenerativeAI(key);

async function test() {
  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash-exp',
  ];
  for (const m of models) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const r = await model.generateContent('Hi');
      console.log('✓ Model', m, 'SUCCESS:', r.response.text().trim());
      return;
    } catch (e: any) {
      console.log('✗ Model', m, 'error:', e.message.slice(0, 150));
    }
  }
}
test();
