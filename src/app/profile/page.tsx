'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileUp, Loader2, GraduationCap, Briefcase, Mail, Phone, Link2, MapPin, User, Save, Target as TargetIcon, DollarSign, Check, Ban, Trash2, Star, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { LatexTemplatePanel } from '@/components/latex-template-panel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useProfile, revalidateMatches, revalidateDigest } from '@/lib/hooks';

interface Targets {
  roles?: string[];
  locations?: string[];
  comp_min?: number;
  comp_max?: number;
  comp_currency?: string;
  must_haves?: string;
  deal_breakers?: string;
}
interface Profile {
  skills: string[];
  experience: string[];
  education: string[];
  location?: string;
  seniority?: string;
  title?: string;
  yearsOfExperience?: number;
  name?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  targets?: Targets;
  suggested_roles?: string[];
  domain_terms?: string[];
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  pincode?: string;
  currentCtcInr?: number;
  expectedCtcInr?: number;
}
interface ResumeMeta {
  id: number;
  label: string;
  isActive: boolean;
  hasEmbedding: boolean;
  updatedAt: string;
  name?: string;
  title?: string;
  skillCount: number;
  roleCount: number;
}

export default function ProfilePage() {
  const { profile, updatedAt, refresh, isLoading } = useProfile();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadLabel, setUploadLabel] = useState('');
  const [resumes, setResumes] = useState<ResumeMeta[]>([]);
  const [busyResumeId, setBusyResumeId] = useState<number | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [contact, setContact] = useState({
    name: '',
    email: '',
    phone: '',
    linkedin: '',
    location: '',
    street: '',
    city: '',
    state: '',
    country: '',
    zipCode: '',
    currentCtcInr: '',
    expectedCtcInr: '',
  });
  const [savingTargets, setSavingTargets] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Focus areas (resume-derived domain vocabulary that drives the matcher's soft boost).
  const [domainDraft, setDomainDraft] = useState<string[]>([]);
  const [newDomainTerm, setNewDomainTerm] = useState('');
  const [regenDomains, setRegenDomains] = useState(false);
  const [savingDomains, setSavingDomains] = useState(false);
  const [targets, setTargets] = useState({
    roles: '',
    locations: '',
    comp_min: '',
    comp_max: '',
    comp_currency: 'USD',
    must_haves: '',
    deal_breakers: '',
  });

  // Sync local contact form state when profile loads
  useEffect(() => {
    if (profile) {
      setContact({
        name: profile.name || '',
        email: profile.email || '',
        phone: profile.phone || '',
        linkedin: profile.linkedin || '',
        location: profile.location || '',
        street: profile.street || '',
        city: profile.city || '',
        state: profile.state || '',
        country: profile.country || '',
        zipCode: profile.zipCode || profile.pincode || '',
        currentCtcInr: profile.currentCtcInr ? String(profile.currentCtcInr) : '',
        expectedCtcInr: profile.expectedCtcInr ? String(profile.expectedCtcInr) : '',
      });
      const t = profile.targets || {};
      // Default currency: INR for India-based profiles, USD otherwise. User can override.
      const defaultCurrency =
        t.comp_currency
          || (profile.location && /india/i.test(profile.location) ? 'INR' : 'USD');
      setTargets({
        // Pre-fill roles/locations from parsed resume if user hasn't saved targets yet.
        // This means "what role am I targeting" defaults to "the title in my resume" until
        // the user explicitly overrides — saves an empty form on first visit.
        roles: (t.roles || []).join(', ') || (profile.title ? profile.title : ''),
        locations: (t.locations || []).join(', ') || (profile.location && /india/i.test(profile.location) ? 'India, Remote' : profile.location || ''),
        comp_min: t.comp_min != null ? String(t.comp_min) : '',
        comp_max: t.comp_max != null ? String(t.comp_max) : '',
        comp_currency: defaultCurrency,
        must_haves: t.must_haves || '',
        deal_breakers: t.deal_breakers || '',
      });
      setDomainDraft(Array.isArray(profile.domain_terms) ? profile.domain_terms : []);
    }
  }, [profile]);

  // Live-format a comp value so the user sees what they typed (e.g. 1500000 → "₹15.0L / yr")
  const formatCompPreview = (raw: string, currency: string): string => {
    if (!raw) return '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (currency === 'INR') {
      if (n >= 100_000) return `≈ ₹${(n / 100_000).toFixed(1)}L / yr`;
      return `≈ ₹${n.toLocaleString('en-IN')} / yr (looks low — INR is usually 6-7 digits)`;
    }
    const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
    if (n >= 1000) return `≈ ${symbol}${(n / 1000).toFixed(0)}K / yr`;
    return `≈ ${symbol}${n.toLocaleString('en-US')} / yr`;
  };

  // Pre-fill placeholders by currency so the user knows what unit to type.
  const compPlaceholder = (which: 'min' | 'max', currency: string): string => {
    if (currency === 'INR') return which === 'min' ? '1500000' : '3000000';
    if (currency === 'GBP') return which === 'min' ? '70000' : '120000';
    if (currency === 'EUR') return which === 'min' ? '70000' : '120000';
    return which === 'min' ? '80000' : '140000';
  };

  const saveContact = async () => {
    setSavingContact(true);
    try {
      const payload = {
        ...contact,
        currentCtcInr: contact.currentCtcInr ? Number(contact.currentCtcInr) : undefined,
        expectedCtcInr: contact.expectedCtcInr ? Number(contact.expectedCtcInr) : undefined,
        pincode: contact.zipCode,
      };
      const res = await fetch('/api/resume', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        await refresh();
        toast.success('Contact & auto-apply details saved');
      }
    } catch {
      toast.error('Failed to save');
    } finally {
      setSavingContact(false);
    }
  };

  const saveTargets = async () => {
    setSavingTargets(true);
    try {
      const targetsPayload: Targets = {
        roles: targets.roles.split(',').map((s) => s.trim()).filter(Boolean),
        locations: targets.locations.split(',').map((s) => s.trim()).filter(Boolean),
        comp_min: targets.comp_min ? Number(targets.comp_min) : undefined,
        comp_max: targets.comp_max ? Number(targets.comp_max) : undefined,
        comp_currency: targets.comp_currency || undefined,
        must_haves: targets.must_haves || undefined,
        deal_breakers: targets.deal_breakers || undefined,
      };
      const res = await fetch('/api/resume', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: targetsPayload }),
      });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        await refresh();
        // Targets now genuinely affect ranking (roles, locations, comp floor, must-haves,
        // deal-breakers), so the match list and digest must be re-fetched. Without this the
        // browser kept serving the stale SWR list for up to 30s and "Save" appeared to do nothing
        // — every other save on this page already did it; saveTargets was the one that didn't.
        revalidateMatches();
        revalidateDigest();
        toast.success('Career targets saved — matches re-ranked');
      }
    } catch {
      toast.error('Failed to save');
    } finally {
      setSavingTargets(false);
    }
  };

  // --- Adaptive role targeting: recommended-role chips ---------------------
  // The enabled set is derived from the comma-joined `targets.roles` string so
  // toggling a chip and free-text editing stay in sync. Chips come from the
  // resume-derived `profile.suggested_roles`.
  const enabledRoles = new Set(
    targets.roles.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const currentRoleList = () => targets.roles.split(',').map((s) => s.trim()).filter(Boolean);

  const toggleRole = (role: string) => {
    const list = currentRoleList();
    const idx = list.findIndex((r) => r.toLowerCase() === role.toLowerCase());
    if (idx >= 0) list.splice(idx, 1);
    else list.push(role);
    setTargets({ ...targets, roles: list.join(', ') });
  };

  const selectAllRoles = () => {
    const suggested = profile?.suggested_roles || [];
    // Union of currently-typed roles + all suggested (preserve any custom entries).
    const merged = [...currentRoleList()];
    for (const r of suggested) if (!merged.some((m) => m.toLowerCase() === r.toLowerCase())) merged.push(r);
    setTargets({ ...targets, roles: merged.join(', ') });
  };

  const regenerateRoles = async () => {
    setRegenerating(true);
    try {
      const res = await fetch('/api/profile/roles', { method: 'POST' });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        await refresh();
        toast.success(`Recommended ${data.suggestedRoles?.length ?? 0} roles from your resume`);
      }
    } catch {
      toast.error('Failed to regenerate roles');
    } finally {
      setRegenerating(false);
    }
  };

  // --- Focus areas (domain terms) ---
  const addDomainTerm = () => {
    const t = newDomainTerm.trim().replace(/\s+/g, ' ');
    if (!t || t.length > 40) return;
    if (domainDraft.some((d) => d.toLowerCase() === t.toLowerCase())) { setNewDomainTerm(''); return; }
    setDomainDraft([...domainDraft, t]);
    setNewDomainTerm('');
  };
  const removeDomainTerm = (term: string) => {
    setDomainDraft(domainDraft.filter((d) => d.toLowerCase() !== term.toLowerCase()));
  };
  const saveDomains = async () => {
    setSavingDomains(true);
    try {
      const res = await fetch('/api/profile/domains', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain_terms: domainDraft }),
      });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        await refresh();
        revalidateMatches();
        toast.success('Focus areas saved — matches re-ranked.');
      }
    } catch {
      toast.error('Failed to save focus areas');
    } finally {
      setSavingDomains(false);
    }
  };
  const regenerateDomains = async () => {
    setRegenDomains(true);
    try {
      const res = await fetch('/api/profile/domains', { method: 'POST' });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        setDomainDraft(data.domainTerms || []);
        await refresh();
        revalidateMatches();
        toast.success(`Derived ${data.domainTerms?.length ?? 0} focus areas from your resume`);
      }
    } catch {
      toast.error('Failed to regenerate focus areas');
    } finally {
      setRegenDomains(false);
    }
  };

  const fetchResumes = useCallback(async () => {
    try {
      const res = await fetch('/api/resumes');
      const data = await res.json();
      setResumes(data.resumes || []);
    } catch { /* leave list as-is */ }
  }, []);

  useEffect(() => { fetchResumes(); }, [fetchResumes]);

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.pdf')) {
      toast.error('Please upload a PDF file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File too large (max 5MB)');
      return;
    }
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    if (uploadLabel.trim()) formData.append('label', uploadLabel.trim());
    try {
      const res = await fetch('/api/resume', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        toast.success(`"${data.label}" added & activated — ${data.skillCount} skills.`);
        setUploadLabel('');
        await refresh();
        await fetchResumes();
        // New active embedding → matches and digest are stale
        revalidateMatches();
        revalidateDigest();
      }
    } catch {
      toast.error('Failed to upload resume');
    } finally {
      setUploading(false);
    }
  }, [refresh, uploadLabel, fetchResumes]);

  const switchResume = useCallback(async (id: number) => {
    setBusyResumeId(id);
    try {
      const res = await fetch(`/api/resumes/${id}/activate`, { method: 'POST' });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        toast.success('Active resume switched — matches will recompute.');
        await refresh();
        await fetchResumes();
        revalidateMatches();
        revalidateDigest();
      }
    } catch {
      toast.error('Failed to switch resume');
    } finally {
      setBusyResumeId(null);
    }
  }, [refresh, fetchResumes]);

  const deleteResume = useCallback(async (id: number, label: string) => {
    if (!confirm(`Delete resume "${label}"? This can't be undone.`)) return;
    setBusyResumeId(id);
    try {
      const res = await fetch(`/api/resumes/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        toast.success('Resume deleted.');
        await refresh();
        await fetchResumes();
        revalidateMatches();
        revalidateDigest();
      }
    } catch {
      toast.error('Failed to delete resume');
    } finally {
      setBusyResumeId(null);
    }
  }, [refresh, fetchResumes]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  // While the profile is loading for the first time, show a spinner instead of a flash of the
  // empty/upload state (which reads as "no résumé" before the real data arrives).
  if (isLoading && !profile) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Loading your profile…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your parsed resume drives matching. Upload a new PDF any time to refresh skills and embeddings.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      {/* Left column: edit contact + targets */}
      <div className="space-y-6">
      {profile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4" />
              Contact & Auto-Apply Info
            </CardTitle>
            <CardDescription>
              Candidate contact details, address, and compensation used for LinkedIn Easy Apply and external ATS form filling.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <User className="h-3 w-3" /> Name
                </label>
                <Input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <Mail className="h-3 w-3" /> Email
                </label>
                <Input value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <Phone className="h-3 w-3" /> Phone
                </label>
                <Input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <Link2 className="h-3 w-3" /> LinkedIn
                </label>
                <Input value={contact.linkedin} onChange={(e) => setContact({ ...contact, linkedin: e.target.value })} placeholder="https://linkedin.com/in/..." />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Street Address
                </label>
                <Input value={contact.street} onChange={(e) => setContact({ ...contact, street: e.target.value })} placeholder="e.g. 123 Main Street / Madurai" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> City
                </label>
                <Input value={contact.city} onChange={(e) => setContact({ ...contact, city: e.target.value, location: e.target.value ? `${e.target.value}, India` : contact.location })} placeholder="Madurai" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> State / Province
                </label>
                <Input value={contact.state} onChange={(e) => setContact({ ...contact, state: e.target.value })} placeholder="Tamil Nadu" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Country
                </label>
                <Input value={contact.country} onChange={(e) => setContact({ ...contact, country: e.target.value })} placeholder="India" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Postal / Zip Code
                </label>
                <Input value={contact.zipCode} onChange={(e) => setContact({ ...contact, zipCode: e.target.value })} placeholder="625001" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <DollarSign className="h-3 w-3" /> Current CTC (INR / yr)
                </label>
                <Input value={contact.currentCtcInr} onChange={(e) => setContact({ ...contact, currentCtcInr: e.target.value })} placeholder="700000" />
                {contact.currentCtcInr && Number(contact.currentCtcInr) > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    ≈ ₹{(Number(contact.currentCtcInr) / 100_000).toFixed(1)} LPA
                  </span>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <DollarSign className="h-3 w-3" /> Expected CTC (INR / yr)
                </label>
                <Input value={contact.expectedCtcInr} onChange={(e) => setContact({ ...contact, expectedCtcInr: e.target.value })} placeholder="1200000" />
                {contact.expectedCtcInr && Number(contact.expectedCtcInr) > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    ≈ ₹{(Number(contact.expectedCtcInr) / 100_000).toFixed(1)} LPA
                  </span>
                )}
              </div>
            </div>
            <Button onClick={saveContact} disabled={savingContact} size="sm">
              {savingContact ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save contact & apply details
            </Button>
          </CardContent>
        </Card>
      )}

      {profile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TargetIcon className="h-4 w-4" />
              Career targets
            </CardTitle>
            <CardDescription>
              Your &quot;North Star&quot; — fed into evaluation, cover letter, and resume-variant prompts. Better targets = sharper matching.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <Briefcase className="h-3 w-3" /> Target roles (comma-separated)
              </label>
              {(profile?.suggested_roles?.length ?? 0) > 0 && (
                <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Recommended from your resume — tap to include
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={selectAllRoles}
                        className="text-[11px] font-medium text-primary hover:underline"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={regenerateRoles}
                        disabled={regenerating}
                        className="text-[11px] font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Regenerate
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(profile?.suggested_roles || []).map((role) => {
                      const on = enabledRoles.has(role.toLowerCase());
                      return (
                        <button
                          type="button"
                          key={role}
                          onClick={() => toggleRole(role)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                            on
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                          )}
                        >
                          {on ? <Check className="h-3 w-3" /> : null}
                          {role}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground/70">
                    Selected roles drive job hunting (search terms) and rank matching roles higher. Remember to Save.
                  </p>
                </div>
              )}
              <Input
                value={targets.roles}
                onChange={(e) => setTargets({ ...targets, roles: e.target.value })}
                placeholder="Solution Architect, Senior Engineer, Engineering Lead"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <TargetIcon className="h-3 w-3" /> Focus areas
              </label>
              <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Domain vocabulary from your resume — boosts jobs that match
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={regenerateDomains}
                      disabled={regenDomains}
                      className="text-[11px] font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      {regenDomains ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Regenerate
                    </button>
                    <button
                      type="button"
                      onClick={saveDomains}
                      disabled={savingDomains}
                      className="text-[11px] font-medium text-primary hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      {savingDomains ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Save
                    </button>
                  </div>
                </div>
                {domainDraft.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {domainDraft.map((term) => (
                      <span
                        key={term}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary"
                      >
                        {term}
                        <button
                          type="button"
                          onClick={() => removeDomainTerm(term)}
                          className="ml-0.5 text-primary/60 hover:text-primary"
                          aria-label={`Remove ${term}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground/70">
                    None yet — click Regenerate to derive them from your resume, or add your own below.
                  </p>
                )}
                <div className="flex items-center gap-1.5">
                  <Input
                    value={newDomainTerm}
                    onChange={(e) => setNewDomainTerm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDomainTerm(); } }}
                    placeholder="Add a focus area (e.g. Kubernetes, FHIR, fintech)"
                    className="h-8 text-xs"
                  />
                  <button
                    type="button"
                    onClick={addDomainTerm}
                    className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40"
                  >
                    Add
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground/70">
                  A job whose description contains 3+ of these gets a small ranking boost. Resume-derived, so it works for any field — edit to steer toward domains you want to explore.
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" /> Target locations (comma-separated)
              </label>
              <Input
                value={targets.locations}
                onChange={(e) => setTargets({ ...targets, locations: e.target.value })}
                placeholder="Remote, India, Global remote"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <DollarSign className="h-3 w-3" /> Target compensation (annual gross)
              </p>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground/80">Min / yr</label>
                  <Input
                    type="number"
                    value={targets.comp_min}
                    onChange={(e) => setTargets({ ...targets, comp_min: e.target.value })}
                    placeholder={compPlaceholder('min', targets.comp_currency)}
                  />
                  <p className="text-[10px] text-muted-foreground tabular min-h-[14px]">{formatCompPreview(targets.comp_min, targets.comp_currency)}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground/80">Max / yr</label>
                  <Input
                    type="number"
                    value={targets.comp_max}
                    onChange={(e) => setTargets({ ...targets, comp_max: e.target.value })}
                    placeholder={compPlaceholder('max', targets.comp_currency)}
                  />
                  <p className="text-[10px] text-muted-foreground tabular min-h-[14px]">{formatCompPreview(targets.comp_max, targets.comp_currency)}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground/80">Currency</label>
                  <select
                    value={targets.comp_currency}
                    onChange={(e) => setTargets({ ...targets, comp_currency: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-card text-foreground px-3 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
                  >
                    <option className="bg-card text-foreground py-1">USD</option>
                    <option className="bg-card text-foreground py-1">INR</option>
                    <option className="bg-card text-foreground py-1">EUR</option>
                    <option className="bg-card text-foreground py-1">GBP</option>
                    <option className="bg-card text-foreground py-1">CAD</option>
                    <option className="bg-card text-foreground py-1">AUD</option>
                  </select>
                  <p className="text-[10px] text-muted-foreground min-h-[14px]">
                    {targets.comp_currency === 'INR' ? 'Enter raw rupees (e.g. 1500000 = ₹15L)' : 'Enter raw amount (e.g. 80000 = $80K)'}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <Check className="h-3 w-3" /> Must-haves
              </label>
              <textarea
                value={targets.must_haves}
                onChange={(e) => setTargets({ ...targets, must_haves: e.target.value })}
                rows={2}
                placeholder="Healthcare-IT or B2B SaaS, FHIR/HL7 experience, India-friendly remote, async culture"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <Ban className="h-3 w-3" /> Deal-breakers
              </label>
              <textarea
                value={targets.deal_breakers}
                onChange={(e) => setTargets({ ...targets, deal_breakers: e.target.value })}
                rows={2}
                placeholder="On-site only, defense contractors, sub-$60k, crypto-native"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <Button onClick={saveTargets} disabled={savingTargets} size="sm">
              {savingTargets ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save targets
            </Button>
          </CardContent>
        </Card>
      )}
      </div>

      {/* Right column: view profile + resume library + upload */}
      <div className="space-y-6">
      {profile && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>
                  {profile.title || 'Current profile'}
                  {profile.seniority && (
                    <Badge variant="outline" className="ml-2 align-middle text-[10px] uppercase tracking-wide">
                      {profile.seniority}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {profile.location || 'Location unspecified'}
                  {profile.yearsOfExperience != null && ` · ${profile.yearsOfExperience} yrs`}
                </CardDescription>
              </div>
              {updatedAt && (
                <span className="text-xs text-muted-foreground tabular">
                  Updated {new Date(updatedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            <Separator />

            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium">Skills</h3>
                <span className="text-xs text-muted-foreground tabular">{profile.skills.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {profile.skills.map((skill, i) => (
                  <Badge key={i} variant="secondary" className="font-normal">
                    {skill}
                  </Badge>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <div className="flex items-center gap-2 mb-2">
                <Briefcase className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Experience</h3>
                <span className="text-xs text-muted-foreground tabular ml-auto">{profile.experience.length}</span>
              </div>
              <ul className="space-y-1.5 text-sm text-foreground/80">
                {profile.experience.slice(0, 8).map((exp, i) => (
                  <li key={i} className="truncate">
                    · {exp}
                  </li>
                ))}
                {profile.experience.length > 8 && (
                  <li className="text-xs text-muted-foreground">+ {profile.experience.length - 8} more</li>
                )}
              </ul>
            </div>

            <Separator />

            <div>
              <div className="flex items-center gap-2 mb-2">
                <GraduationCap className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Education</h3>
              </div>
              <ul className="space-y-1 text-sm text-foreground/80">
                {profile.education.map((edu, i) => (
                  <li key={i}>· {edu}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resume library — keep multiple resumes (e.g. generic + healthcare) and switch active */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Resume library
          </CardTitle>
          <CardDescription>
            Keep multiple resumes (e.g. a generic one and a healthcare-specific one). The
            <span className="font-medium text-foreground"> active</span> resume drives matching,
            evaluations, and generated documents. Switching recomputes your matches.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {resumes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No resumes yet — upload one below.</p>
          ) : (
            resumes.map((r) => (
              <div
                key={r.id}
                className={cn(
                  'flex items-center gap-3 rounded-md border p-3',
                  r.isActive ? 'border-primary/40 bg-primary/5' : 'border-border'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{r.label}</span>
                    {r.isActive && (
                      <Badge variant="success" className="gap-1 text-[10px]">
                        <Star className="h-3 w-3" /> Active
                      </Badge>
                    )}
                    {!r.hasEmbedding && (
                      <Badge variant="warning" className="text-[10px]">no embedding</Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[r.title, `${r.skillCount} skills`, `${r.roleCount} roles`].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {!r.isActive && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyResumeId === r.id}
                    onClick={() => switchResume(r.id)}
                  >
                    {busyResumeId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Use
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busyResumeId === r.id}
                  onClick={() => deleteResume(r.id, r.label)}
                  aria-label={`Delete ${r.label}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <LatexTemplatePanel />

      <Card>
        <CardContent
          className={cn(
            'p-0 transition-colors',
            dragOver ? 'bg-accent' : undefined
          )}
        >
          <div
            className={cn(
              'rounded-lg p-10 text-center border-2 border-dashed m-px',
              dragOver ? 'border-primary' : 'border-border/60'
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {uploading ? (
              <div className="space-y-3">
                <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Parsing resume…</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-accent">
                  <FileUp className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Add a resume to your library
                  </p>
                  <p className="text-xs text-muted-foreground">PDF only, max 5 MB · becomes the active resume</p>
                </div>
                <div className="mx-auto max-w-xs">
                  <Input
                    value={uploadLabel}
                    onChange={(e) => setUploadLabel(e.target.value)}
                    placeholder='Label (optional), e.g. "Healthcare" or "Generic"'
                    className="text-center"
                  />
                </div>
                <Button asChild size="sm" variant="default">
                  <label className="cursor-pointer">
                    Choose PDF
                    <input type="file" accept=".pdf" className="hidden" onChange={handleFileInput} />
                  </label>
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      </div>
      </div>
    </div>
  );
}
