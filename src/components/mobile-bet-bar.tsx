"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A bar pinned to the bottom of phone screens with the current price and a Bet button that jumps to the trade panel
 * (the one and only TradeForm). It hides itself while the panel is on screen.
 */
export function MobileBetBar({ summary }: { summary: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = document.getElementById("trade");
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      aria-hidden={!visible}
      className={`fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-200 lg:hidden ${visible ? "translate-y-0" : "translate-y-full"}`}
    >
      <div className="mx-auto flex max-w-280 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{summary}</span>
        <Button
          type="button" className="h-10 px-6 text-base" tabIndex={visible ? 0 : -1}
          onClick={() => document.getElementById("trade")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >Bet</Button>
      </div>
    </div>
  );
}
