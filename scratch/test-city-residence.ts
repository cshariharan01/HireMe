export function normalizeCityName(cityName: string): string {
  const c = cityName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^hyd(?:e?rabad)?$/i.test(c) || c === 'hyd') return 'hyderabad';
  if (/^b(?:angalore|engaluru|lr)$/i.test(c)) return 'bangalore';
  if (/^(?:chennai|madras)$/i.test(c) || c === 'maa') return 'chennai';
  if (/^(?:mumbai|bombay)$/i.test(c) || c === 'bom') return 'mumbai';
  if (/^(?:kolkata|calcutta)$/i.test(c) || c === 'ccu') return 'kolkata';
  if (/^(?:gurgaon|gurugram)$/i.test(c)) return 'gurgaon';
  if (/^noida$/i.test(c)) return 'noida';
  if (/^(?:delhi|newdelhi|ncr)$/i.test(c)) return 'delhi';
  if (/^pune$/i.test(c) || c === 'pnq') return 'pune';
  if (/^madurai$/i.test(c) || c === 'ixm') return 'madurai';
  if (/^(?:coimbatore|kovai)$/i.test(c) || c === 'cjb') return 'coimbatore';
  if (/^(?:kochi|cochin)$/i.test(c) || c === 'cok') return 'kochi';
  if (/^(?:trivandrum|thiruvananthapuram)$/i.test(c)) return 'thiruvananthapuram';
  if (/^ahmedabad$/i.test(c) || c === 'amd') return 'ahmedabad';
  return c;
}

export function matchCityResidenceQuestion(
  questionText: string,
  candidateLocation?: string,
): { isResidenceQuestion: boolean; answer: 'Yes' | 'No'; targetCity: string } | null {
  const q = questionText.trim();

  // 1. Open-ended questions asking for city name are NOT Yes/No residence checks
  if (/\b(where|which city|what city|what is your)\b/i.test(q)) {
    return null;
  }

  // 2. Questions asking "residing in X or willing to relocate?" -> Candidate is willing to relocate -> Yes
  if (/(?:residing|living|staying|based|located).{1,40}(?:or\s+willing\s+to\s+relocate|or\s+ready\s+to\s+relocate|or\s+open\s+to\s+relocate)/i.test(q)) {
    return { isResidenceQuestion: true, answer: 'Yes', targetCity: '' };
  }

  // 3. Pure relocation / willingness questions are handled separately (normally 'Yes')
  if (/\b(?:willing\s+to|ready\s+to|open\s+to|comfortable\s+to|can\s+you)\s+relocate\b/i.test(q)) {
    return null;
  }

  // 4. City residence check patterns
  const patterns = [
    // "Are you residing curretly in Hydrabad ?" / "Do you stay in Pune?" / "Is your current location Hyderabad?"
    /(?:are\s+you|do\s+you|is\s+your)\s+(?:currently|curretly|presently|at\s+present)?\s*(?:residing|living|staying|based|located|stay|live|reside|current\s+location)\s*(?:in|at|from|is)?\s+([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
    // "Currently residing in Hyderabad?" / "Living in Chennai?" / "Residing in Pune?"
    /^(?:currently|curretly|presently|at\s+present)?\s*(?:residing|living|staying|based|located)\s+(?:in|at)\s+([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
    // "Are you currently in Hyderabad?"
    /(?:are\s+you)\s+(?:currently|curretly|presently|at\s+present)\s+(?:in|at)\s+([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
    // "Current location : Hyderabad?" / "Current location - Pune?"
    /^current\s+location\s*[-:]\s*([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
  ];

  let rawTargetCity: string | null = null;
  for (const pat of patterns) {
    const match = q.match(pat);
    if (match && match[1]) {
      rawTargetCity = match[1].trim();
      break;
    }
  }

  if (!rawTargetCity) return null;

  // Clean trailing filler words like "city", "right now", "currently"
  const cleanedTarget = rawTargetCity
    .replace(/\s+(?:city|area|location|right now|currently|curretly)$/i, '')
    .trim();

  if (!cleanedTarget) return null;

  // Extract candidate city
  const candLoc = candidateLocation || 'Madurai, India';
  const candCityRaw = candLoc.split(',')[0].trim();
  const candNormalized = normalizeCityName(candCityRaw);

  // Target may contain multiple cities: e.g. "Hyderabad / Bangalore" or "Hyderabad or Bangalore"
  const targetCities = cleanedTarget.split(/\s*(?:\/|\bor\b|,)\s*/i).map(normalizeCityName);

  const isMatch = targetCities.some((c) => c === candNormalized);

  return {
    isResidenceQuestion: true,
    answer: isMatch ? 'Yes' : 'No',
    targetCity: cleanedTarget,
  };
}

// Run test cases
const userLocation = 'Madurai, India';
const testCases = [
  { q: 'Are you residing curretly in Hydrabad ?', expected: 'No' },
  { q: 'Are you residing currently in Hyderabad ?', expected: 'No' },
  { q: 'Are you currently residing in Bangalore ?', expected: 'No' },
  { q: 'Are you residing in Madurai ?', expected: 'Yes' },
  { q: 'Do you currently stay in Hyderabad ?', expected: 'No' },
  { q: 'Do you live in Chennai?', expected: 'No' },
  { q: 'Are you based in Hyderabad?', expected: 'No' },
  { q: 'Are you located in Madurai, India?', expected: 'Yes' },
  { q: 'Are you residing in Pune ?', expected: 'No' },
  { q: 'Currently residing in Hyderabad ?', expected: 'No' },
  { q: 'Residing in Madurai ?', expected: 'Yes' },
  { q: 'Are you currently in Hyderabad ?', expected: 'No' },
  { q: 'Current location : Hyderabad ?', expected: 'No' },
  { q: 'Are you residing in Hyderabad or willing to relocate ?', expected: 'Yes' },
  { q: 'Where are you currently residing ?', expected: null },
  { q: 'What is your current location ?', expected: null },
  { q: 'Are you willing to relocate to Hyderabad ?', expected: null },
];

console.log('=== TESTING CITY RESIDENCE MATCHER ===');
let passed = 0;
for (const tc of testCases) {
  const res = matchCityResidenceQuestion(tc.q, userLocation);
  const ans = res ? res.answer : null;
  const ok = ans === tc.expected;
  if (ok) passed++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] "${tc.q}" -> got "${ans}", expected "${tc.expected}"`);
}

console.log(`\nResult: ${passed} / ${testCases.length} passed.`);
