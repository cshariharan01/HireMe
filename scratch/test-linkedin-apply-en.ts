import { linkedInApply } from '../src/lib/apply/linkedin';

(async () => {
  console.log('Testing full linkedInApply on job 4440422331...');
  
  const result = await linkedInApply({
    jobUrl: 'https://www.linkedin.com/jobs/view/4440422331/',
    autoSubmit: false,
    profile: {
      name: 'Hariharan Subramaniyan',
      email: 'cshariharan2001@gmail.com',
      phone: '6383827363'
    },
    resumePdfBytes: new Uint8Array(),
    resumeFilename: 'Hariharan_Resume.pdf'
  });

  console.log('Apply Result:', JSON.stringify(result, null, 2));
})().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
