function formatJobAge(postedAt, ingestedAt, ageDays) {
  const ref = postedAt || ingestedAt;
  if (!ref && (ageDays === null || ageDays === undefined)) return 'Recently';

  if (ref) {
    const normalized = ref.includes('T') ? ref : ref.replace(' ', 'T') + (ref.length > 10 ? 'Z' : '');
    const timeMs = new Date(normalized).getTime();
    if (Number.isFinite(timeMs)) {
      const nowMs = new Date('2026-09-14T13:08:00+05:30').getTime(); // Current local time: ~07:38 UTC
      const diffMs = Math.max(0, nowMs - timeMs);
      const diffMins = Math.floor(diffMs / 60_000);
      const diffHours = Math.floor(diffMs / 3_600_000);
      const diffDays = Math.floor(diffMs / 86_400_000);

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

console.log('10 mins ago:', formatJobAge('2026-09-14 07:28:00'));
console.log('1 hour ago:', formatJobAge('2026-09-14 06:30:00'));
console.log('6 hours ago:', formatJobAge('2026-09-14 01:30:00'));
console.log('Yesterday (2026-09-13):', formatJobAge('2026-09-13'));
console.log('4 days ago (2026-09-10):', formatJobAge('2026-09-10'));
console.log('Fallback ageDays 1:', formatJobAge(null, null, 1));
