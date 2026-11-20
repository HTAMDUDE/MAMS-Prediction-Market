import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder shapes shown by the loading.tsx files while a page streams in. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="gap-3 p-4">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-8 w-full" />
        </Card>
      ))}
    </div>
  );
}

export function PageSkeleton({ title = true, blocks = 3 }: { title?: boolean; blocks?: number }) {
  return (
    <div className="space-y-4" role="status" aria-label="Loading">
      {title && <Skeleton className="h-8 w-48" />}
      {Array.from({ length: blocks }, (_, i) => (
        <Card key={i} className="gap-3 p-4 sm:p-5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-16 w-full" />
        </Card>
      ))}
    </div>
  );
}
