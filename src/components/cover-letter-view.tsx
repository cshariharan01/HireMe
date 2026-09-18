'use client';

import { useMemo, useState } from 'react';
import { Mail, Phone, Globe, MapPin, Copy, Check, Download, FileText, Calendar, Building } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { downloadBlob } from '@/lib/download-blob';

interface CoverLetterViewProps {
  markdown: string;
  company?: string;
  jobTitle?: string;
  candidateName?: string;
  className?: string;
}

interface ParsedCoverLetter {
  name: string;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  date: string | null;
  recipient: string | null;
  salutation: string | null;
  bodyParagraphs: string[];
  signoff: string | null;
  signature: string | null;
}

function parseCoverLetter(raw: string, defaultName?: string, defaultCompany?: string): ParsedCoverLetter {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());

  let name = defaultName || '';
  let email: string | null = null;
  let phone: string | null = null;
  let linkedin: string | null = null;
  let location: string | null = null;
  let date: string | null = null;
  let recipient: string | null = null;
  let salutation: string | null = null;
  const bodyParagraphs: string[] = [];
  let signoff: string | null = null;
  let signature: string | null = null;

  // Split raw text into chunks by blank lines
  const chunks = raw
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);

  let i = 0;
  // First chunk is almost always the candidate contact header
  if (chunks.length > 0) {
    const headerLines = chunks[0].split('\n').map((l) => l.trim()).filter(Boolean);
    for (const h of headerLines) {
      if (!name && !h.includes('@') && !/^\+?\d[\d\s-]{6,}/.test(h) && !h.includes('linkedin.com')) {
        name = h.replace(/^#+\s*/, '').trim();
      } else if (h.includes('@')) {
        email = h.replace(/^.*?[<\s]?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[>\s]?.*$/, '$1');
      } else if (/linkedin\.com/i.test(h)) {
        linkedin = h.replace(/^(https?:\/\/)?(www\.)?/, 'https://');
      } else if (/^\+?\d[\d\s-]{7,}/.test(h)) {
        phone = h;
      } else if (/india|city|state|remote|[A-Za-z]+,\s*[A-Za-z]+/i.test(h)) {
        location = h;
      }
    }
    i = 1;
  }

  // Next chunk might be date
  if (i < chunks.length) {
    const candidateDate = chunks[i].replace(/^Date:\s*/i, '').trim();
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2})/i.test(candidateDate)) {
      date = candidateDate;
      i++;
    }
  }

  // Next chunk might be recipient / Hiring Team
  if (i < chunks.length) {
    const candidateRec = chunks[i];
    if (/Hiring Manager|Team|Recruiter|Human Resources|Talent Acquisition/i.test(candidateRec) && !candidateRec.toLowerCase().startsWith('dear')) {
      recipient = candidateRec;
      i++;
    }
  }

  // Next chunk is salutation (e.g. "Dear Hiring Manager,")
  if (i < chunks.length) {
    const candidateSal = chunks[i];
    if (candidateSal.toLowerCase().startsWith('dear') || candidateSal.endsWith(':') || candidateSal.endsWith(',')) {
      salutation = candidateSal;
      i++;
    }
  }

  // Body and closing chunks
  for (; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i === chunks.length - 1 && /^(sincerely|warmly|best regards|regards|respectfully|thank you)/i.test(chunk)) {
      const parts = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
      signoff = parts[0];
      signature = parts.slice(1).join(' ') || name;
    } else if (i === chunks.length - 2 && /^(sincerely|warmly|best regards|regards|respectfully|thank you)/i.test(chunk)) {
      signoff = chunk;
      signature = chunks[i + 1] || name;
      break;
    } else {
      bodyParagraphs.push(chunk);
    }
  }

  return {
    name: name || defaultName || 'Candidate',
    email,
    phone,
    linkedin,
    location,
    date: date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    recipient: recipient || (defaultCompany ? `${defaultCompany} Hiring Team` : null),
    salutation: salutation || 'Dear Hiring Manager,',
    bodyParagraphs: bodyParagraphs.length > 0 ? bodyParagraphs : [raw],
    signoff: signoff || 'Sincerely,',
    signature: signature || name || defaultName || 'Candidate',
  };
}

export function CoverLetterView({
  markdown,
  company,
  jobTitle,
  candidateName,
  className,
}: CoverLetterViewProps) {
  const [copied, setCopied] = useState(false);
  const [downloadingDocx, setDownloadingDocx] = useState(false);

  const parsed = useMemo(() => {
    return parseCoverLetter(markdown, candidateName, company);
  }, [markdown, candidateName, company]);

  const handleCopy = () => {
    navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadTxt = () => {
    const blob = new Blob([markdown], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, `Cover_Letter_${(company || 'Job').replace(/[^\w-]+/g, '_')}.txt`);
  };

  const handleDownloadDocx = async () => {
    setDownloadingDocx(true);
    try {
      const { markdownToDocxBlob } = await import('@/lib/markdown-to-docx');
      const filename = `Cover_Letter_${(company || 'Job').replace(/[^\w-]+/g, '_')}`;
      const blob = await markdownToDocxBlob(markdown, filename);
      downloadBlob(blob, `${filename}.docx`);
    } catch {
      handleDownloadTxt();
    } finally {
      setDownloadingDocx(false);
    }
  };

  return (
    <div className={cn('space-y-3', className)}>
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 border-b pb-2 text-xs">
        <div className="flex items-center gap-2 font-medium text-foreground/80">
          <FileText className="h-4 w-4 text-primary" />
          <span>Executive Cover Letter</span>
          {company && <span className="text-muted-foreground">for {company}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="h-7 px-2.5 text-xs gap-1"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadDocx}
            disabled={downloadingDocx}
            className="h-7 px-2.5 text-xs gap-1"
          >
            <Download className="h-3.5 w-3.5" />
            Word (.docx)
          </Button>
        </div>
      </div>

      {/* Styled Letter Paper Presentation */}
      <div className="rounded-lg border bg-background/95 p-6 sm:p-8 shadow-sm space-y-6 text-foreground font-sans">
        {/* Letterhead */}
        <div className="space-y-2.5 pb-4 border-b">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            {parsed.name}
          </h1>

          {/* Contact Details Bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {parsed.email && (
              <a
                href={`mailto:${parsed.email}`}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <Mail className="h-3.5 w-3.5 text-primary/70" />
                <span>{parsed.email}</span>
              </a>
            )}
            {parsed.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5 text-primary/70" />
                <span>{parsed.phone}</span>
              </span>
            )}
            {parsed.linkedin && (
              <a
                href={parsed.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <Globe className="h-3.5 w-3.5 text-primary/70" />
                <span>{parsed.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '')}</span>
              </a>
            )}
            {parsed.location && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 text-primary/70" />
                <span>{parsed.location}</span>
              </span>
            )}
          </div>
        </div>

        {/* Date & Recipient Details */}
        <div className="space-y-1 text-xs text-muted-foreground">
          {parsed.date && (
            <p className="flex items-center gap-1.5 text-foreground/80 font-medium">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              {parsed.date}
            </p>
          )}
          {parsed.recipient && (
            <div className="pt-2 text-foreground/90 font-medium space-y-0.5">
              <p className="flex items-center gap-1.5">
                <Building className="h-3.5 w-3.5 text-muted-foreground" />
                {parsed.recipient}
              </p>
              {jobTitle && <p className="text-muted-foreground text-[11px]">Re: {jobTitle}</p>}
            </div>
          )}
        </div>

        {/* Salutation */}
        <div className="pt-2 text-sm font-semibold text-foreground">
          {parsed.salutation}
        </div>

        {/* Body Paragraphs */}
        <div className="space-y-3.5 text-sm text-foreground/90 leading-relaxed font-normal">
          {parsed.bodyParagraphs.map((para, idx) => (
            <p key={idx} className="text-justify sm:text-left">
              {para}
            </p>
          ))}
        </div>

        {/* Formal Sign-off */}
        <div className="pt-4 space-y-3 text-sm">
          <p className="text-foreground/90">{parsed.signoff}</p>
          <div className="pt-1">
            <p className="font-semibold text-foreground">{parsed.signature}</p>
            {jobTitle && <p className="text-xs text-muted-foreground">{jobTitle} Candidate</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
