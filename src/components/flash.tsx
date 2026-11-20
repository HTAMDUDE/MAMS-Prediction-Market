"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";

const COOKIE = "mams_flash";

/** Shows (once) the message an action stored in a cookie before redirecting. */
export function Flash() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
    if (!match) return;
    document.cookie = `${COOKIE}=; path=/; max-age=0`;
    try {
      const { type, message } = JSON.parse(decodeURIComponent(match.slice(COOKIE.length + 1)));
      (type === "error" ? toast.error : toast.success)(message);
    } catch {
      /* ignore a malformed cookie */
    }
  }, [pathname, search]);
  return null;
}
