'use client';

import { useState, useRef, useEffect, useId } from 'react';
import { MapPin, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

export const POPULAR_LOCATIONS = [
  'Chennai',
  'Bangalore',
  'Coimbatore',
  'Remote',
  'Hyderabad',
  'Pune',
  'Mumbai',
  'Delhi / NCR',
  'Gurugram',
  'Noida',
  'Kolkata',
  'India',
  'Global Remote',
];

export const PRESET_LOCATIONS = [
  'Chennai',
  'Bangalore',
  'Bengaluru',
  'Coimbatore',
  'Remote',
  'Hyderabad',
  'Pune',
  'Mumbai',
  'Delhi / NCR',
  'Gurugram',
  'Noida',
  'Kolkata',
  'Ahmedabad',
  'Kochi',
  'Thiruvananthapuram',
  'Trichy',
  'Madurai',
  'Salem',
  'Tirunelveli',
  'Vellore',
  'Erode',
  'Dindigul',
  'Jaipur',
  'Indore',
  'Chandigarh',
  'Lucknow',
  'Bhubaneswar',
  'Nagpur',
  'Visakhapatnam',
  'Surat',
  'Vadodara',
  'Mysore',
  'Mangalore',
  'Puducherry',
  'India',
  'Global Remote',
  'United States',
  'US Remote',
];

interface LocationInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  className?: string;
  isMulti?: boolean;
  showQuickPills?: boolean;
}

export function LocationInput({
  value,
  onChange,
  placeholder = 'e.g. Remote, Chennai, Bangalore',
  className,
  isMulti = true,
  showQuickPills = true,
}: LocationInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Extract the current token being typed (after last comma if isMulti)
  const lastCommaIndex = isMulti ? value.lastIndexOf(',') : -1;
  const currentToken = isMulti
    ? value.slice(lastCommaIndex + 1).trimStart()
    : value.trim();

  // Already selected items normalized for checking duplicates
  const selectedList = isMulti
    ? value
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [value.trim().toLowerCase()];

  // Filter matching suggestions
  const suggestions = currentToken
    ? PRESET_LOCATIONS.filter((loc) => {
        const lower = loc.toLowerCase();
        // Match prefix or substring
        if (!lower.includes(currentToken.toLowerCase())) return false;
        // Don't show if already in selected list
        return !selectedList.includes(lower);
      }).slice(0, 8)
    : [];

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectSuggestion = (loc: string) => {
    if (isMulti) {
      const beforeLastComma = value.slice(0, lastCommaIndex + 1);
      const prefix = beforeLastComma ? beforeLastComma.trimEnd() + ' ' : '';
      const newValue = `${prefix}${loc}, `;
      onChange(newValue);
    } else {
      onChange(loc);
    }
    setIsOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        e.preventDefault();
        handleSelectSuggestion(suggestions[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const togglePill = (loc: string) => {
    const norm = loc.toLowerCase();
    const currentItems = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const exists = currentItems.some((item) => item.toLowerCase() === norm);
    let updated: string[];
    if (exists) {
      updated = currentItems.filter((item) => item.toLowerCase() !== norm);
    } else {
      updated = [...currentItems, loc];
    }
    onChange(updated.length > 0 ? updated.join(', ') + ', ' : '');
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className={cn('relative space-y-2', className)}>
      <div className="relative">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            if (currentToken.length >= 1) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={isOpen && suggestions.length > 0}
        />

        {/* Suggestion Dropdown */}
        {isOpen && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-auto rounded-lg border bg-popover p-1 shadow-lg backdrop-blur-md">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Location Suggestions
            </div>
            {suggestions.map((loc, idx) => (
              <button
                type="button"
                key={loc}
                onClick={() => handleSelectSuggestion(loc)}
                onMouseEnter={() => setActiveIndex(idx)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-left transition-colors',
                  idx === activeIndex
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-popover-foreground hover:bg-muted'
                )}
              >
                <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>{loc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quick Pills for popular locations */}
      {showQuickPills && isMulti && (
        <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <MapPin className="h-3 w-3 text-primary" /> Popular target locations (tap to add / remove)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {POPULAR_LOCATIONS.map((loc) => {
              const selected = selectedList.includes(loc.toLowerCase());
              return (
                <button
                  type="button"
                  key={loc}
                  onClick={() => togglePill(loc)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all active:scale-95',
                    selected
                      ? 'border-primary/50 bg-primary/15 text-primary font-semibold shadow-xs'
                      : 'border-border/60 bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  )}
                >
                  {selected ? <Check className="h-3 w-3 text-primary" /> : null}
                  <span>{loc}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
