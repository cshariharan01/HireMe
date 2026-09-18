const db = require('better-sqlite3')('data/hiresignal.db');
const j = db.prepare('SELECT description FROM job_postings WHERE id = 18000').get();

function formatJobDescription(raw) {
  if (!raw) return '';
  let text = raw;

  // Replace HTML breaks/paragraphs if present
  text = text.replace(/<br\s*[\/]?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, ' ');

  // Separate inline subheaders like "GCP Services:", "Programming:", "Data Concepts:", "Key Responsibilities:"
  text = text.replace(/([^\n])\s*(Key Responsibilities|Responsibilities|Requirements|Job Requirements\*?|Core Skills|Technical Skills|Qualifications|Preferred Qualifications|Education|Benefits|What We Offer|GCP Services|Programming|Data Concepts|Tools|Location|Overall Exp):/g, '$1\n\n**$2:**\n');

  // Handle stuck together headings like "services.GCP Service Utilization:" or "IndiaJob Requirements*"
  text = text.replace(/(Location-[^\s]+)/g, '\n\n**$1**\n');
  text = text.replace(/(Overall Exp-[^\s]+)/g, '\n\n**$1**\n');
  text = text.replace(/([a-z0-9\.\)])([A-Z][a-zA-Z\s]{2,25}:)/g, '$1\n\n**$2**\n');

  // Break bullet points onto separate lines
  text = text.replace(/([^\n])\s*([•·\*\-]\s+)/g, '$1\n- ');
  text = text.replace(/^([•·\*]\s+)/gm, '- ');

  // Clean up excess whitespace
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

console.log(formatJobDescription(j.description));
