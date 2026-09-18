import { GoogleGenerativeAI } from '@google/generative-ai';

const key = 'AQ.Ab8RN6I8id9dkvKPT-yBxJY6Tc9VOmqfGRpvRWQUyRIlV-Afqg';
console.log('Testing key:', key.slice(0, 10) + '...');

const genAI = new GoogleGenerativeAI(key);

async function test() {
  const modelsToTry = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-flash',
  ];

  for (const m of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const r = await model.generateContent('Hi, reply with OK');
      console.log(`✓ Model ${m} SUCCEEDED:`, r.response.text().trim());
      break;
    } catch (e: any) {
      console.log(`✗ Model ${m} failed:`, e.message.slice(0, 150));
    }
  }
}

test();
