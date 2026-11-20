import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]" role="status" aria-label="Loading market">
      <Card className="gap-3 p-4 sm:p-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-4/5" />
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-56 w-full" />
      </Card>
      <Card className="gap-3 p-4">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </Card>
    </div>
  );
}
