'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Target, User, Upload, ListChecks, Moon, Sun, RefreshCw, FileUp, ExternalLink, Settings as SettingsIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from '@/components/ui/command';

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = !!target?.closest('input, textarea, [contenteditable="true"]');
      const cmdK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
      const question = e.key === '?' && !inInput;
      if (cmdK || question) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    setTimeout(fn, 50);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent hideClose className="overflow-hidden p-0 max-w-xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Quick navigation and actions</DialogDescription>
        <Command>
          <CommandInput placeholder="Type a command or search..." />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>

            <CommandGroup heading="Navigation">
              <CommandItem onSelect={() => run(() => router.push('/'))}>
                <Target />
                Matches
              </CommandItem>
              <CommandItem onSelect={() => run(() => router.push('/profile'))}>
                <User />
                Profile
              </CommandItem>
              <CommandItem onSelect={() => run(() => router.push('/import'))}>
                <Upload />
                Import
              </CommandItem>
              <CommandItem onSelect={() => run(() => router.push('/tracker'))}>
                <ListChecks />
                Tracker
              </CommandItem>
              <CommandItem onSelect={() => run(() => router.push('/settings'))}>
                <SettingsIcon />
                Settings
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="Actions">
              <CommandItem
                onSelect={() =>
                  run(() => {
                    setTheme(theme === 'dark' ? 'light' : 'dark');
                    toast.success(`Switched to ${theme === 'dark' ? 'light' : 'dark'} theme`);
                  })
                }
              >
                {theme === 'dark' ? <Sun /> : <Moon />}
                Toggle theme
              </CommandItem>
              <CommandItem
                onSelect={() =>
                  run(() => {
                    fetch('/api/matches').then(() => {
                      toast.success('Matches refreshed');
                      router.refresh();
                    });
                  })
                }
              >
                <RefreshCw />
                Refresh matches
              </CommandItem>
              <CommandItem onSelect={() => run(() => router.push('/profile'))}>
                <FileUp />
                Upload new resume
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="External">
              <CommandItem onSelect={() => run(() => window.open('https://aistudio.google.com/apikey', '_blank'))}>
                <ExternalLink />
                Get a Gemini API key (free)
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
