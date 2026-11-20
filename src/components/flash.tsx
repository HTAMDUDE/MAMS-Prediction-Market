"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { FLASH_COOKIE } from "@/lib/flash";

/**
 * Shows (once) the message an action stored in a cookie before redirecting. The server layout passes the raw cookie
 * value, so this fires after every redirect, even back to the same URL (each message carries a unique id).
 */
export function Flash({ raw }: { raw: string | null }) {
  useEffect(() => {
    if (!raw) return;
    document.cookie = `${FLASH_COOKIE}=; path=/; max-age=0`;
    try {
      const { type, message } = JSON.parse(raw);
      (type === "error" ? toast.error : toast.success)(message);
    } catch {
      /* ignore a malformed cookie */
    }
  }, [raw]);
  return null;
}
