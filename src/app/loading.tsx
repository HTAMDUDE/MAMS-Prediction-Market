import { CardGridSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading markets">
      <div className="mb-4 space-y-3">
        <Skeleton className="h-11 w-full sm:w-96" />
        <Skeleton className="h-9 w-full sm:w-2/3" />
      </div>
      <CardGridSkeleton />
    </div>
  );
}
