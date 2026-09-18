import { cn } from '@/lib/utils';
import { pctClamp, scoreTier, TIER_CHIP } from '@/lib/score';

// A calm, rounded chip for the 0-100 fit score. Replaces the inline score-tier chips duplicated
// across the dashboard + job detail.
//
// Deliberately NOT rendered with a "%" any more. The number is a bounded composite fit score
// (retrieval + skill overlap + LLM verdict + context), not a probability or a percentage of
// anything — and while it WAS displayed as a percentage it was really `cosine + boosts`, which
// made an unrelated Java role read as "98%".
export function ScoreBadge({
  score,
  className,
  size = 'md',
}: {
  score: number;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const pct = pctClamp(score);
  const tier = scoreTier(score);
  const sizeCls =
    size === 'lg' ? 'text-sm px-2.5 py-1' : size === 'sm' ? 'text-[11px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-semibold tabular',
        TIER_CHIP[tier],
        sizeCls,
        className
      )}
    >
      {pct}
    </span>
  );
}
