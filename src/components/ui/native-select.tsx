import * as React from "react";
import { cn } from "@/lib/utils";

/** A styled native <select>: posts with plain forms, works on every phone. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-base outline-none md:text-sm transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
