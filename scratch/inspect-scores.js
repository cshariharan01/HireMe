const db = require('./src/lib/db').default;

const jobs = db.prepare(`
  SELECT id, company, title, location, apply_type, source, source_platform
  FROM job_postings
  WHERE company LIKE '%Cloudxtreme%'
     OR (company LIKE '%Infosys%' AND title LIKE '%Data Engineer%')
     OR (company LIKE '%Infosys%' AND title LIKE '%Azure Databricks%')
`).all();

console.log('Found jobs:', jobs);
