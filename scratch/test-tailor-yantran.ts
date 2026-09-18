import db from '../src/lib/db';
import { compileLatexWithRepair } from '../src/lib/apply/latex';
import { calculateAndStoreTailoredScore } from '../src/lib/tailored-score';

const yantranTailoredTex = `%-------------------------
% Resume in Latex
% Author: Hariharan Subramaniyan
%------------------------

\\documentclass[letterpaper,11pt]{article}

\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{fontawesome5}
\\usepackage{multicol}
\\usepackage{xcolor}
\\definecolor{richblack}{RGB}{10, 10, 10}
\\AtBeginDocument{\\color{richblack}}
\\setlength{\\multicolsep}{-3.0pt}
\\setlength{\\columnsep}{-1pt}
\\input{glyphtounicode}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\fancypagestyle{plain}{%
  \\fancyhf{}%
  \\fancyfoot{}%
  \\renewcommand{\\headrulewidth}{0pt}%
  \\renewcommand{\\footrulewidth}{0pt}%
}

\\addtolength{\\oddsidemargin}{-0.6in}
\\addtolength{\\evensidemargin}{-0.5in}
\\addtolength{\\textwidth}{1.19in}
\\addtolength{\\topmargin}{-.7in}
\\addtolength{\\textheight}{1.0in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{
  \\vspace{-6pt}\\scshape\\raggedright\\large\\bfseries
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-5pt}]

\\pdfgentounicode=1

\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-2pt}}}}
\\newcommand{\\resumeSubheading}[4]{
  \\vspace{-2pt}\\item
    \\begin{tabularx}{\\textwidth}{@{}X r@{}}
      \\textbf{#1} & \\textbf{\\small #2} \\\\
      \\textit{\\small#3} & \\textit{\\small #4} \\\\
    \\end{tabularx}\\vspace{-6pt}
}
\\newcommand{\\resumeProjectHeading}[2]{
    \\item
    \\begin{tabularx}{\\textwidth}{@{}X r@{}}
      \\small#1 & \\textbf{\\small #2}\\\\
    \\end{tabularx}\\vspace{-6pt}
}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-8pt}}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.0in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}

\\begin{document}
\\thispagestyle{fancy}

%----------HEADING----------
\\begin{center}
    {\\Huge \\scshape Hariharan Subramaniyan} \\\\ \\vspace{4pt}
    \\textbf{\\Large \\scshape Data Engineer} \\\\ \\vspace{4pt}
    \\small \\faPhone\\ +91-6383827363 ~ 
    \\href{mailto:cshariharan2001@gmail.com}{\\faEnvelope\\ \\underline{cshariharan2001@gmail.com}} ~ 
    \\href{https://www.linkedin.com/in/cshariharan01/}{\\faLinkedin\\ \\underline{linkedin.com/in/cshariharan01}} 
\\end{center}

%-----------SUMMARY-----------
\\section{Summary}
Data Engineer with 3+ years of experience designing, developing, and maintaining scalable ETL/ELT data pipelines, cloud data warehouses, and streaming architectures using Python, SQL, Apache Spark / PySpark, Apache Kafka, and Apache Airflow. Hands-on expertise building batch and real-time pipelines across cloud platforms (AWS, Azure, GCP), data lakes, Databricks, and Snowflake, optimizing distributed query performance and automating data ingestion workflows for enterprise analytics.

%-----------SKILLS-----------
\\section{Skills}
\\textbf{Programming \\& Querying:} Python, SQL, PySpark, Advanced SQL \\\\
\\textbf{Data Warehousing \\& Cloud:} Snowflake, Databricks, Cloud Data Lakes, AWS (S3), Azure, GCP, Data Warehousing, ETL/ELT \\\\
\\textbf{Big Data \\& Streaming:} Apache Spark, Spark Streaming, Apache Kafka, Apache Airflow, Apache Cassandra, ClickHouse, MySQL, PostgreSQL \\\\
\\textbf{DevOps \\& Tools:} Docker, Docker Compose, Git, CI/CD, Jenkins, Pentaho Data Integration (PDI / Kettle), Power BI, REST APIs

%-----------Experience-----------
\\section{Experience}
\\resumeSubHeadingListStart
  \\resumeSubheading
    {Software Engineer}{September 2022 -- Present}
    {Solartis Technology, Madurai}{}
    
    \\resumeItemListStart

      \\resumeItem{\\textbf{Tools Used:} Python, SQL, PySpark, Apache Spark, Apache Kafka, Apache Airflow, Snowflake, Databricks, Cloud Data Lakes, ETL/ELT, MySQL, ClickHouse, Docker}

      \\resumeItem{Engineered scalable ETL/ELT data pipelines using Python and PySpark to extract, transform, and load large-scale datasets into centralized cloud data lakes and data warehouses, enhancing processing efficiency by 30\\%.}

      \\resumeItem{Developed CDC-based data ingestion pipelines using Python and Apache Kafka to capture MySQL transactional changes, streaming records for real-time analytics with zero data loss.}

      \\resumeItem{Built scalable ingestion workflows handling INSERT, UPDATE, and DELETE events, synchronizing data across heterogeneous cloud data stores and analytical repositories.}

      \\resumeItem{Implemented distributed data transformation and schema validation logic using PySpark and SQL before loading curated datasets into ClickHouse and cloud data warehouse tables.}

      \\resumeItem{Orchestrated and automated end-to-end data processing workflows using Apache Airflow DAGs, enabling near real-time reporting and boosting data availability by 25\\%.}

      \\resumeItem{Revamped complex MySQL queries, stored procedures, views, and functions, accelerating report generation speed by 35\\% and eliminating critical query bottlenecks for high-throughput workloads.}

      \\resumeItem{Led the design and maintenance of 10+ ETL pipelines leveraging Pentaho Kettle (PDI) and custom Python scripts, automating data extraction, transformation, and loading across customer environments.}

      \\resumeItem{Implemented MySQL JSON functions to perform production data fixes, improving data integrity by 25\\% and boosting operational efficiency for customer-facing analytical systems.}

    \\resumeItemListEnd
\\resumeSubHeadingListEnd

%-----------PROJECTS-----------
\\section{Projects}
\\resumeSubHeadingListStart
  \\resumeProjectHeading
      {\\textbf{Real-Time CDC Data Processing \\& Warehousing Pipeline} $|$ \\emph{Python, Kafka, Spark, PySpark, Snowflake, Databricks, ClickHouse, SQL}}{}
      \\resumeItemListStart
        \\resumeItem{Engineered an enterprise CDC data pipeline capturing MySQL transactional changes and streaming events through Apache Kafka into cloud data lake and warehousing environments.}
        \\resumeItem{Developed Python and PySpark ingestion microservices processing binlog events for incremental data replication into Databricks and Snowflake tables.}
        \\resumeItem{Constructed Apache Spark transformation jobs validating schemas and aggregating event streams, reducing data refresh cycle latency by 30\\%.}
        \\resumeItem{Automated the replication of \\textbf{500+ daily transactional events} into ClickHouse, enabling near real-time business intelligence reporting.}
      \\resumeItemListEnd
  \\resumeProjectHeading
      {\\textbf{Real-Time Streaming Data Pipeline \\& Lakehouse Architecture} $|$ \\emph{Python, Kafka, PySpark, Airflow, Cassandra, Docker, Cloud Data Lakes}}{}
      \\resumeItemListStart
        \\resumeItem{Architected a real-time data streaming pipeline using Apache Kafka continuously streaming user data from REST APIs, \\textbf{processing 60+ records per minute} reliably.}
        \\resumeItem{Orchestrated Apache Airflow DAGs in Python to schedule daily pipeline workflows, minimizing manual intervention and ensuring fault-tolerant data transformation.}
        \\resumeItem{Constructed a Spark Streaming application using PySpark to consume Kafka messages, validate schemas, and persist records to Apache Cassandra with fault-tolerant checkpointing.}
        \\resumeItem{Designed a high-throughput NoSQL data model in Apache Cassandra supporting intensive write operations for real-time analytics delivery.}
      \\resumeItemListEnd
\\resumeSubHeadingListEnd

%-----------AWARDS-----------
\\section{Awards \\& Certifications}
\\resumeItemListStart
  \\resumeItem{\\textbf{Institution Innovation Council - 2021:} Awarded for excellence in the 'Design Thinking' workshop organized by the Institution Innovation Council.}
  \\resumeItem{\\textbf{Best Final Year Project --- 2022, AAA College:} Built a Power BI dashboard analyzing academic performance across 6 departments over 3 years.}
\\resumeItemListEnd

%-----------EDUCATION-----------
\\section{Education}
\\resumeSubHeadingListStart
  \\resumeSubheading
    {B.E. Computer Science and Engineering}{Graduated: 2022}
    {AAA College, Virudhunagar}{CGPA: 7.2 / 10}
\\resumeSubHeadingListEnd
\\end{document}
`;

async function run() {
  const jobId = 1000055;
  console.log('Compiling tailored LaTeX for Yantran...');
  const { bytes, tex } = await compileLatexWithRepair(
    yantranTailoredTex,
    async () => yantranTailoredTex
  );
  console.log('Compiled PDF bytes:', bytes.length);

  // Update DB
  db.prepare(`
    UPDATE my_applications
    SET resume_tex = ?,
        resume_variant = NULL
    WHERE job_id = ?
  `).run(tex, jobId);

  db.prepare(`
    INSERT INTO job_documents (job_id, resume_tex, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(job_id) DO UPDATE SET resume_tex = excluded.resume_tex, updated_at = CURRENT_TIMESTAMP
  `).run(jobId, tex);

  console.log('Computing new tailored score...');
  const scoreResult = await calculateAndStoreTailoredScore(jobId);
  console.log('Score Result:', scoreResult);

  const app = db.prepare('SELECT id, job_id, default_score, tailored_score, LENGTH(resume_tex) as tex_len FROM my_applications WHERE job_id = ?').get(jobId);
  console.log('Updated my_applications:', app);
}

run().catch(console.error);
