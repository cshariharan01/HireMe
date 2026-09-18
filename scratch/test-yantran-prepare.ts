import { prepareSubmission } from '../src/lib/apply/prepare';

async function test() {
  console.log('Testing prepareSubmission for Yantran (1000055)...');
  const result = await prepareSubmission(1000055, { resumeSource: 'tailored' });
  console.log('Result ok:', result.ok);
  console.log('Strategy:', result.strategy);
  console.log('Resume source:', result.resumeSource);
  if (result.plan) {
    console.log('Plan strategy:', result.plan.strategy);
    console.log('Attachments:', {
      resumeFilename: result.plan.attachments?.resume?.filename,
      resumeBytesLen: result.plan.attachments?.resume?.bytes?.length,
      coverLetterFilename: result.plan.attachments?.coverLetter?.filename,
    });
  }
}

test().catch(console.error);
