'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Target, User, Upload, ListChecks, Sparkles, Settings as SettingsIcon, Menu, X, BookOpen,
  PanelLeftOpen, PanelLeftClose, Loader2, Play, Pause, Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { SyncButton } from '@/components/sync-button';
import { ModelSwitchNotifier } from '@/components/model-switch-notifier';
import { useAutoApply } from '@/lib/auto-apply-context';

const NAV_ITEMS = [
  { href: '/', label: 'Matches', icon: Target },
  { href: '/tracker', label: 'Tracker', icon: ListChecks },
  { href: '/profile', label: 'Profile', icon: User },
  { href: '/import', label: 'Import', icon: Upload },
  { href: '/guide', label: 'Guide', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.href === '/' ? (pathname === '/' || pathname === '/matches') : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2 px-1">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <span className="text-[15px] font-semibold tracking-tight">HireMe</span>
    </Link>
  );
}

function SidebarInner({
  onNavigate,
  isExpanded,
  onToggleExpand,
}: {
  onNavigate?: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4 p-3 overflow-y-auto">
      <div className="flex items-center justify-between pt-1 shrink-0">
        <Wordmark />
        {onToggleExpand && (
          <button
            onClick={onToggleExpand}
            aria-label={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
            title={isExpanded ? 'Collapse sidebar (standard width)' : 'Expand sidebar (wider view for live sync statuses)'}
            className="hidden md:inline-flex items-center justify-center rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {isExpanded ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </button>
        )}
      </div>
      <div className="shrink-0">
        <NavLinks onNavigate={onNavigate} />
      </div>
      <div className="mt-auto flex flex-col gap-3 shrink-0 pt-2">
        <SyncButton isSidebarExpanded={isExpanded} />
        <div className="flex items-center justify-between px-1">
          <span className="hidden items-center gap-1 rounded-md border bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground sm:inline-flex">
            <span className="text-xs">⌘</span>K
          </span>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

function AutoApplyGlobalWidget() {
  const pathname = usePathname();
  const {
    autoApplyRunning,
    autoApplyPaused,
    autoApplyProgress,
    autoApplyStatusMessage,
    pauseAutoApply,
    resumeAutoApply,
    stopAutoApply,
  } = useAutoApply();

  if (!autoApplyRunning || pathname === '/') return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-primary/40 bg-card/95 p-3 shadow-2xl backdrop-blur-md max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-200">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground truncate">
            {autoApplyProgress
              ? `Job [${autoApplyProgress.current}/${autoApplyProgress.total}] · ${autoApplyProgress.company}`
              : 'Auto-Apply Running'}
          </span>
          <Badge variant={autoApplyPaused ? 'warning' : 'success'} className="text-[9px] px-1 py-0 shrink-0">
            {autoApplyPaused ? 'Paused' : 'Running'}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5 font-medium">
          {autoApplyProgress?.stepText || autoApplyStatusMessage || 'Processing application...'}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {autoApplyPaused ? (
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={resumeAutoApply} title="Resume Auto-Apply">
            <Play className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={pauseAutoApply} title="Pause Auto-Apply">
            <Pause className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={stopAutoApply} title="Stop Auto-Apply">
          <Square className="h-3.5 w-3.5 fill-current" />
        </Button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('hireme_sidebar_expanded');
      if (saved === 'true') setSidebarExpanded(true);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSidebar = () => {
    setSidebarExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('hireme_sidebar_expanded', String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar with expandable width */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 border-r bg-card/40 md:block transition-[width] duration-300 ease-in-out',
          sidebarExpanded ? 'w-[400px]' : 'w-60'
        )}
      >
        <SidebarInner isExpanded={sidebarExpanded} onToggleExpand={toggleSidebar} />
      </aside>

      {/* Mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-md md:hidden">
          <button aria-label="Menu" onClick={() => setDrawerOpen(true)} className="rounded-lg p-1.5 hover:bg-accent">
            <Menu className="h-5 w-5" />
          </button>
          <Wordmark />
        </header>

        <main className="min-w-0 flex-1">
          {/* Full-width content */}
          <div className="w-full px-4 py-6 md:px-6">{children}</div>
        </main>
      </div>

      <ModelSwitchNotifier />
      <AutoApplyGlobalWidget />

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 border-r bg-card shadow-pop">
            <button
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-2 top-2 rounded-lg p-1.5 text-muted-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarInner onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
