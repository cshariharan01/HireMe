'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  ExternalLink,
  Loader2,
  CheckCircle2,
  ShieldCheck,
  Globe,
  RefreshCw,
  Download,
  LogOut,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function LinkedinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
    </svg>
  );
}

function NaukriIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-4 13.5V8.5h2.5l3.5 5.5V8.5H16v7h-2.5L10 10v5.5H8z" />
    </svg>
  );
}

export function PlatformLoginCard({ compact = false }: { compact?: boolean }) {
  const [loadingPlatform, setLoadingPlatform] = useState<string | null>(null);
  const [disconnectingPlatform, setDisconnectingPlatform] = useState<string | null>(null);
  const [status, setStatus] = useState<{ linkedin: boolean; naukri: boolean }>({
    linkedin: false,
    naukri: false,
  });
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [importing, setImporting] = useState(false);

  const importFromChrome = async (force = false) => {
    setImporting(true);
    try {
      const res = await fetch('/api/auth/import-cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(data.message || 'Imported Chrome sessions successfully!');
        await checkStatus();
      } else if (data.chromeRunning) {
        if (
          confirm(
            'Chrome is open and locking the cookie database. Close Chrome now to import all signed-in accounts and cookies? (You can reopen Chrome right after)'
          )
        ) {
          await importFromChrome(true);
        }
      } else {
        toast.error(data.error || 'Failed to import Chrome sessions.');
      }
    } catch {
      toast.error('Failed to import Chrome sessions.');
    } finally {
      setImporting(false);
    }
  };

  const checkStatus = useCallback(async () => {
    try {
      setCheckingStatus(true);
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data?.connected) {
        setStatus({
          linkedin: !!data.connected.linkedin,
          naukri: !!data.connected.naukri,
        });
      }
    } catch {
      // ignore
    } finally {
      setCheckingStatus(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    // Poll periodically while on settings page
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const disconnectPlatform = async (platform: 'naukri' | 'linkedin' | 'all') => {
    setDisconnectingPlatform(platform);
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      const data = await res.json();
      if (data.ok) {
        const platLabel =
          platform === 'all'
            ? 'All platform sessions'
            : platform === 'naukri'
            ? 'Naukri session'
            : 'LinkedIn session';
        toast.success(`${platLabel} cleared. Browser profile is clean.`);
        await checkStatus();
      } else {
        toast.error(data.error || 'Failed to disconnect session.');
      }
    } catch {
      toast.error('Failed to disconnect platform session.');
    } finally {
      setDisconnectingPlatform(null);
    }
  };

  const launchLogin = async (platform: 'naukri' | 'linkedin', clearSession = false) => {
    setLoadingPlatform(platform);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, clearSession }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(
          `Chrome window opened for ${
            platform === 'naukri' ? 'Naukri' : 'LinkedIn'
          }. Please sign in in the Chrome window.`
        );
        setTimeout(checkStatus, 4000);
      } else {
        toast.error(data.error || 'Could not launch Chrome login window.');
      }
    } catch {
      toast.error('Failed to launch Chrome browser.');
    } finally {
      setLoadingPlatform(null);
    }
  };

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!!loadingPlatform || !!disconnectingPlatform}
            onClick={() => launchLogin('naukri', false)}
            className="border-orange-500/30 text-orange-600 dark:text-orange-400 hover:bg-orange-500/10"
          >
            {loadingPlatform === 'naukri' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <NaukriIcon className="mr-1.5 h-3.5 w-3.5 text-orange-500" />
            )}
            {status.naukri ? 'Naukri (Connected)' : 'Sign into Naukri'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!!disconnectingPlatform}
            onClick={() => disconnectPlatform('naukri')}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-red-500"
            title="Switch / Disconnect Naukri account"
          >
            {disconnectingPlatform === 'naukri' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!!loadingPlatform || !!disconnectingPlatform}
            onClick={() => launchLogin('linkedin', false)}
            className="border-[#0A66C2]/30 text-[#0A66C2] dark:text-[#70B5F9] hover:bg-[#0A66C2]/10"
          >
            {loadingPlatform === 'linkedin' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <LinkedinIcon className="mr-1.5 h-3.5 w-3.5" />
            )}
            {status.linkedin ? 'LinkedIn (Connected)' : 'Sign into LinkedIn'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!!disconnectingPlatform}
            onClick={() => disconnectPlatform('linkedin')}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-red-500"
            title="Switch / Disconnect LinkedIn account"
          >
            {disconnectingPlatform === 'linkedin' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Platform Connections (Naukri &amp; LinkedIn)</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Sign into your candidate accounts in HireMe&apos;s dedicated browser profile. Sessions are kept isolated from your regular computer Chrome.
          </p>
        </div>

        {/* Action Header Buttons: Always visible */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => disconnectPlatform('all')}
            disabled={disconnectingPlatform === 'all'}
            className="h-8 text-xs font-medium border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 shadow-xs"
            title="Disconnect all platform sessions and wipe browser profile cookies to sign in with a new user account"
          >
            {disconnectingPlatform === 'all' ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5 mr-1.5" />
            )}
            Disconnect All
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => importFromChrome(false)}
            disabled={importing}
            className="h-8 text-xs font-medium border-primary/30 hover:bg-primary/5 shadow-xs"
            title="Import logged-in Google & platform sessions directly from your system Chrome"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin text-primary" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5 text-primary" />
            )}
            Import from My Chrome
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={checkStatus}
            disabled={checkingStatus}
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            title="Refresh connection status"
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1', checkingStatus && 'animate-spin')} />
            Check Status
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        {/* Naukri Login Card */}
        <div className="flex flex-col justify-between rounded-lg border border-orange-500/20 bg-orange-500/5 p-3.5 space-y-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <NaukriIcon className="h-5 w-5 text-orange-500 shrink-0" />
              <div>
                <p className="text-xs font-semibold text-orange-600 dark:text-orange-400">Naukri Account</p>
                <p className="text-[11px] text-muted-foreground">Direct Apply &amp; profile resume upload</p>
              </div>
            </div>
            {status.naukri ? (
              <span className="inline-flex items-center text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-500" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                Not Connected
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={loadingPlatform === 'naukri' || disconnectingPlatform === 'naukri'}
                onClick={() => launchLogin('naukri', false)}
                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white font-medium text-xs h-9"
              >
                {loadingPlatform === 'naukri' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                )}
                {status.naukri ? 'Open Session' : 'Sign into Naukri'}
              </Button>

              <Button
                size="sm"
                variant="outline"
                disabled={loadingPlatform === 'naukri' || disconnectingPlatform === 'naukri'}
                onClick={() => disconnectPlatform('naukri')}
                className="border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 text-xs h-9 px-3 shrink-0"
                title="Wipe Naukri session cookies and disconnect so you can sign in with another account"
              >
                {disconnectingPlatform === 'naukri' ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <LogOut className="mr-1 h-3.5 w-3.5" />
                )}
                Switch Account
              </Button>
            </div>
          </div>
        </div>

        {/* LinkedIn Login Card */}
        <div className="flex flex-col justify-between rounded-lg border border-[#0A66C2]/20 bg-[#0A66C2]/5 p-3.5 space-y-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <LinkedinIcon className="h-5 w-5 text-[#0A66C2] dark:text-[#70B5F9] shrink-0" />
              <div>
                <p className="text-xs font-semibold text-[#0A66C2] dark:text-[#70B5F9]">LinkedIn Account</p>
                <p className="text-[11px] text-muted-foreground">1-Click Easy Apply &amp; job sync</p>
              </div>
            </div>
            {status.linkedin ? (
              <span className="inline-flex items-center text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-500" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                Not Connected
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={loadingPlatform === 'linkedin' || disconnectingPlatform === 'linkedin'}
                onClick={() => launchLogin('linkedin', false)}
                className="flex-1 bg-[#0A66C2] hover:bg-[#084e96] text-white font-medium text-xs h-9"
              >
                {loadingPlatform === 'linkedin' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                )}
                {status.linkedin ? 'Open Session' : 'Sign into LinkedIn'}
              </Button>

              <Button
                size="sm"
                variant="outline"
                disabled={loadingPlatform === 'linkedin' || disconnectingPlatform === 'linkedin'}
                onClick={() => disconnectPlatform('linkedin')}
                className="border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 text-xs h-9 px-3 shrink-0"
                title="Wipe LinkedIn session cookies and disconnect so you can sign in with another account"
              >
                {disconnectingPlatform === 'linkedin' ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <LogOut className="mr-1 h-3.5 w-3.5" />
                )}
                Switch Account
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground space-y-1.5 border">
        <p className="font-medium text-foreground text-[11px] flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          Dedicated Browser Profile Notice:
        </p>
        <p className="text-[11px] leading-relaxed">
          HireMe runs inside its own isolated browser session (<code className="font-mono bg-muted px-1 rounded text-[10px]">data/playwright/browser-profile</code>). Signing out on your computer Chrome <strong>does not sign you out of HireMe</strong>.
        </p>
        <p className="text-[11px] leading-relaxed flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {status.naukri || status.linkedin
              ? 'To switch to a different account, click "Switch Account" or "Disconnect All", then sign in with your new user credentials.'
              : 'Both platforms are currently clean and disconnected. Click "Sign into Naukri" or "Sign into LinkedIn" to sign into your new candidate account.'}
          </span>
        </p>
      </div>
    </div>
  );
}
