"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * A button that opens a dialog holding server-rendered controls. The dialog stays open while the page data refreshes
 * after an action, so several actions can be taken in a row.
 */
export function ManageDialog({ title, description, triggerLabel = "Manage", children }: {
  title: string;
  description?: ReactNode;
  triggerLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="max-sm:h-9 max-sm:px-3" aria-label={`${triggerLabel} ${title}`} onClick={() => setOpen(true)}>{triggerLabel}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    </>
  );
}
