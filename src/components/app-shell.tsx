'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Target, User, Upload, ListChecks, Sparkles, Settings as SettingsIcon, Menu, X, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/theme-toggle';
import { SyncButton } from '@/components/sync-button';

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
        const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
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
      <span className="text-[15px] font-semibold tracking-tight">HireSignal</span>
    </Link>
  );
}

function SidebarInner({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="pt-1">
        <Wordmark />
      </div>
      <NavLinks onNavigate={onNavigate} />
      <div className="mt-auto flex flex-col gap-3">
        <SyncButton />
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r bg-card/40 md:block">
        <SidebarInner />
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
          {/* Full-width content. Form-heavy pages (Profile/Settings/Import) center themselves
              with their own max-w wrappers; wide views (Matches/Tracker) fill the width. */}
          <div className="w-full px-4 py-6 md:px-6">{children}</div>
        </main>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-64 border-r bg-card shadow-pop">
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
