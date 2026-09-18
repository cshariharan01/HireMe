import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading UI.
 *
 * There was no `loading.tsx` anywhere in the app, so clicking a nav link left the PREVIOUS page on
 * screen with no feedback until the next one was ready — which reads as "the click did nothing".
 * App Router renders this instantly on navigation while the route segment streams in.
 */
export default function Loading() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
