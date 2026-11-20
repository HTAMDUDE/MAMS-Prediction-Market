"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Label } from "@/components/ui/label";

/**
 * A labelled form field. The label is tied to the control (click the label to focus it, and screen readers
 * announce it). A single input/select/textarea gets the id; a plain element (e.g. a radio group) is labelled by
 * reference; several controls are wrapped in a labelled group.
 */
export function Field({ label, hint, hintBelow, children, className = "space-y-1.5" }: { label: ReactNode; hint?: string; hintBelow?: string; children: ReactNode; className?: string }) {
  const id = useId();
  const labelId = `${id}-label`;
  let control = children;
  if (isValidElement(children)) {
    const el = children as ReactElement<{ id?: string }>;
    control = typeof el.type === "string"
      ? cloneElement(el as ReactElement<Record<string, unknown>>, { "aria-labelledby": labelId })
      : cloneElement(el, { id: el.props.id ?? id });
  } else {
    control = <div role="group" aria-labelledby={labelId} className="space-y-2">{children}</div>;
  }
  return (
    <div className={className}>
      <Label id={labelId} htmlFor={isValidElement(children) && typeof (children as ReactElement).type !== "string" ? id : undefined}>
        {label}{hint && <em className="ml-1 font-normal text-muted-foreground">{hint}</em>}
      </Label>
      {control}
      {hintBelow && <p className="text-xs text-muted-foreground">{hintBelow}</p>}
    </div>
  );
}
