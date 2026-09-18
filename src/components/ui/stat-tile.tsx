import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

// Compact metric tile (extracted from the dashboard's inline MetricCard).
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border bg-card p-4 shadow-soft', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular">{value}</p>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground truncate">{hint}</p>}
        </div>
        {Icon && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
    </div>
  );
}
