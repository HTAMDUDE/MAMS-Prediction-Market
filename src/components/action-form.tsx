"use client";

import { useActionState, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import type { ActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export function showResult(state: ActionState) {
  if (!state) return;
  if (state.ok) toast.success(state.message, state.persist ? { duration: 60000 } : undefined);
  else toast.error(state.message, state.persist ? { duration: 60000 } : undefined);
}

/** A form wired to a server action: shows the result as a toast and exposes the pending state to its children. */
export function ActionForm({
  action, children, className, onResult, resetOnSuccess,
}: {
  action: FormAction;
  children: ReactNode | ((s: { pending: boolean; state: ActionState }) => ReactNode);
  className?: string;
  onResult?: (state: NonNullable<ActionState>) => void;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state) return;
    showResult(state);
    onResult?.(state);
    if (state.ok && resetOnSuccess) ref.current?.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {typeof children === "function" ? children({ pending, state }) : children}
    </form>
  );
}

/** A submit button that asks "are you sure?" first. Must be rendered inside a form. */
export function ConfirmButton({
  title = "Are you sure?", message, confirmLabel = "Confirm", name, value, noValidate, children, ...buttonProps
}: {
  title?: string;
  message: string;
  confirmLabel?: string;
  name?: string;
  value?: string;
  /** Skip the browser's required-field checks when confirmed (e.g. for Reject). */
  noValidate?: boolean;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, "type" | "onClick" | "name" | "value">) {
  const [open, setOpen] = useState(false);
  const submitter = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={submitter} type="submit" name={name} value={value} formNoValidate={noValidate} hidden aria-hidden tabIndex={-1} />
      <Button type="button" onClick={() => setOpen(true)} {...buttonProps}>{children}</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => submitter.current?.click()}>{confirmLabel}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
