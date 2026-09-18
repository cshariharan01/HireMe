async function test() {
  const t0 = Date.now();
  console.log('Fetching test linkedin job view...');
  try {
    const res = await fetch('https://www.linkedin.com/jobs/view/4164627192/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    console.log('Status:', res.status, 'Time:', Date.now() - t0, 'ms');
  } catch (err) {
    console.log('Error:', err.message, 'Time:', Date.now() - t0, 'ms');
  }
}
test();
