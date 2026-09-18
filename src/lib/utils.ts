import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format job posting / ingestion age into human-readable relative time:
 * 'Just now', '15m ago', '1 hour ago', '8 hours ago', '1d ago', '3d ago', etc.
 */
export function formatJobAge(
  postedAt?: string | null,
  ingestedAt?: string | null,
  ageDays?: number | null
): string {
  const ref = postedAt || ingestedAt;
  if (!ref && (ageDays === null || ageDays === undefined)) return 'Recently';

  if (ref) {
    // Normalise ISO or SQLite "YYYY-MM-DD HH:MM:SS" (stored in UTC)
    const normalized = ref.includes('T') ? ref : ref.replace(' ', 'T') + (ref.length > 10 && !ref.endsWith('Z') ? 'Z' : '');
    const timeMs = new Date(normalized).getTime();
    if (Number.isFinite(timeMs)) {
      const diffMs = Math.max(0, Date.now() - timeMs);
      const diffMins = Math.floor(diffMs / 60_000);
      const diffHours = Math.floor(diffMs / 3_600_000);
      const diffDays = Math.floor(diffMs / 86_400_000);

      // If the string only contained date (e.g. "YYYY-MM-DD")
      if (ref.length === 10) {
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return '1d ago';
        return `${diffDays}d ago`;
      }

      if (diffMins < 5) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours === 1) return '1 hour ago';
      if (diffHours < 24) return `${diffHours} hours ago`;
      if (diffDays === 1) return '1d ago';
      if (diffDays < 30) return `${diffDays}d ago`;
      const months = Math.floor(diffDays / 30);
      return `${months}mo ago`;
    }
  }

  if (ageDays !== null && ageDays !== undefined) {
    if (ageDays === 0) return 'Today';
    if (ageDays === 1) return '1d ago';
    return `${ageDays}d ago`;
  }

  return 'Recently';
}
