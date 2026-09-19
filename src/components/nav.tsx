'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Target, User, Upload, ListChecks, Sparkles, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/theme-toggle';

const NAV_ITEMS = [
  { href: '/', label: 'Matches', icon: Target },
  { href: '/profile', label: 'Profile', icon: User },
  { href: '/import', label: 'Import', icon: Upload },
  { href: '/tracker', label: 'Tracker', icon: ListChecks },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center gap-2 sm:gap-4 overflow-x-auto">
        <Link href="/" className="flex items-center gap-2 shrink-0 mr-2 sm:mr-6">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight">HireMe</span>
        </Link>

        <nav className="flex items-center gap-1 text-sm shrink-0">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <kbd className="hidden sm:inline-flex h-7 select-none items-center gap-1 rounded-md border bg-muted px-2 font-mono text-[10px] font-medium text-muted-foreground">
            <span className="text-xs">⌘</span>K
          </kbd>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
