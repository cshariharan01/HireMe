'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, FileText, CheckCircle2, AlertTriangle } from 'lucide-react';

interface LatexStatus {
  resumeTex: string | null;
  hasCompiler: boolean;
  templateDetected: boolean;
}

/**
 * LaTeX template management for the AI-tailored résumé lane. When a template is saved (paste your
 * Overleaf main.tex) AND a LaTeX compiler is installed, tailored résumés are produced by editing
 * THAT template and compiling it — keeping the user's real résumé design instead of the generic
 * Markdown template. Without either, the Markdown renderer is used unchanged.
 */
export function LatexTemplatePanel() {
  const [status, setStatus] = useState<LatexStatus | null>(null);
  const [tex, setTex] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/resume/latex');
      const data = (await res.json()) as LatexStatus;
      setStatus(data);
      setTex(data.resumeTex || '');
      if (data.resumeTex) setSavedAt('saved');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/resume/latex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tex }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save template.');
        return;
      }
      setStatus((prev) => ({ ...(prev as LatexStatus), resumeTex: tex, templateDetected: data.templateDetected, hasCompiler: data.hasCompiler }));
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }, [tex]);

  const clear = useCallback(async () => {
    setTex('');
    setError(null);
    try {
      const res = await fetch('/api/resume/latex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tex: '' }),
      });
      if (res.ok) {
        setStatus((prev) => ({ ...(prev as LatexStatus), resumeTex: null, templateDetected: false }));
        setSavedAt(null);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to clear template.');
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const lane = status?.hasCompiler && status.templateDetected ? 'active' : status?.hasCompiler ? 'no-template' : status?.templateDetected ? 'no-compiler' : 'off';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Overleaf / LaTeX résumé template
          {lane === 'active' && (
            <Badge variant="success" className="gap-1 text-[10px]">
              <CheckCircle2 className="h-3 w-3" /> ACTIVE
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Paste your Overleaf <code className="text-[11px]">main.tex</code> here to make AI-tailored résumés keep your real
          design. The résumé content is rewritten for the target job inside <em>your</em> template, then compiled to PDF.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {loading ? (
            <Badge variant="outline"><Loader2 className="mr-1 h-3 w-3 animate-spin" /> checking…</Badge>
          ) : (
            <>
              <Badge variant={status?.hasCompiler ? 'success' : 'warning'}>
                {status?.hasCompiler ? 'LaTeX compiler found' : 'No LaTeX compiler on PATH'}
              </Badge>
              <span className="text-muted-foreground">
                {status?.hasCompiler
                  ? 'Tailored résumés will compile with your template.'
                  : 'Install MiKTeX or TeX Live, then reload this page — until then the Markdown template is used. (No restart needed, unlike the app server.)'}
              </span>
            </>
          )}
        </div>

        {!loading && (
          <>
            <textarea
              className="min-h-[180px] w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-primary/50"
              placeholder={'\\documentclass{article}\n\\usepackage[margin=0.6in]{geometry}\n...\n\\begin{document}\n\n... your résumé content ...\n\n\\end{document}'}
              value={tex}
              onChange={(e) => { setTex(e.target.value); setError(null); }}
              spellCheck={false}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={save} disabled={saving || !tex.trim()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {status?.resumeTex ? 'Save template' : 'Save template'}
              </Button>
              {status?.resumeTex && (
                <Button size="sm" variant="ghost" onClick={clear} disabled={saving}>
                  Clear
                </Button>
              )}
              {savedAt && <span className="text-xs text-muted-foreground">Saved {savedAt}</span>}
              {status?.hasCompiler && status.templateDetected && tex.trim() && (
                <span className="ml-auto text-xs text-muted-foreground">{tex.trim().length.toLocaleString()} chars</span>
              )}
            </div>
            {error && (
              <p className="flex items-center gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> {error}
              </p>
            )}
            {tex.trim() && !/\\documentclass/.test(tex) && (
              <p className="flex items-center gap-2 text-xs text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" /> This doesn&apos;t look like a LaTeX document — it should start with <code className="text-[11px]">\documentclass</code>.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}