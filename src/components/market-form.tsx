"use client";

import { useState, type ReactNode } from "react";
import { CATEGORIES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { ActionForm, ConfirmButton, type FormAction } from "@/components/action-form";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

export type MarketFormValues = {
  question: string; description: string; rules_source: string; rules_otherwise: string;
  outcomes: string; category: string; closes_at: string; liquidity: string; review_note: string;
};

const YESNO_RULES = { label: "Resolves YES if…", placeholder: "Resolves YES if the official results list MAMS in first place." };
const MULTI_RULES = { label: "How the winner is decided", placeholder: "The winner is the month of the first full-day weather cancellation." };
const SMALL_HEADING = "pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

function isYesNo(outcomes: string) {
  const typed = (outcomes || "Yes\nNo").split(/\r?\n/).map((x) => x.trim().toLowerCase());
  return typed.length === 2 && typed[0] === "yes" && typed[1] === "no";
}

/**
 * The market form shared by Propose, Admin → Create and Review proposal: Yes/No vs multiple-choice toggle, rules
 * fields, and (when `preview` is set) a live preview card next to the form. `aside` is shown under the preview.
 */
export function MarketForm({
  action, initial, showLiquidity, preview, aside, submitLabel, hidden, review, intro,
}: {
  action: FormAction;
  initial: Partial<MarketFormValues>;
  showLiquidity?: boolean;
  preview?: boolean;
  aside?: ReactNode;
  submitLabel?: string;
  hidden?: Record<string, string | number>;
  /** Review mode adds the note to the proposer and Approve / Reject buttons. */
  review?: { proposer: string };
  intro?: ReactNode;
}) {
  const blank: MarketFormValues = {
    question: "", description: "", rules_source: "", rules_otherwise: "", outcomes: "", category: "Academics",
    closes_at: "", liquidity: "medium", review_note: "", ...initial,
  };
  const startsYesNo = isYesNo(blank.outcomes);
  const [v, setV] = useState<MarketFormValues>(blank);
  const [kind, setKind] = useState<"yesno" | "multi">(startsYesNo ? "yesno" : "multi");
  const [outcomes, setOutcomes] = useState(startsYesNo ? "Option A\nOption B" : blank.outcomes);
  const set = (k: keyof MarketFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  const yesno = kind === "yesno";
  const rules = yesno ? YESNO_RULES : MULTI_RULES;

  const form = (
    <Card className="gap-4 p-4 sm:p-5">
      {intro}
      <ActionForm
        action={action}
        className="space-y-4"
        onResult={(s) => {
          if (s.ok && !review) {
            setV({ ...blank, question: "", description: "", rules_source: "", rules_otherwise: "" });
            setKind("yesno");
          }
        }}
      >
        {({ pending }) => (
          <>
            {Object.entries(hidden ?? {}).map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
            <Field label="Type of market">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1" role="radiogroup">
                {([["yesno", "Yes / No"], ["multi", "Multiple choice"]] as const).map(([val, label]) => (
                  <label key={val} className="cursor-pointer">
                    <input type="radio" name="kind" value={val} checked={kind === val} onChange={() => setKind(val)} className="peer sr-only" />
                    <span className="block rounded-md py-2 text-center text-sm font-semibold text-muted-foreground peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">{label}</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Question"><Input name="question" maxLength={200} required value={v.question} onChange={set("question")} placeholder="Will MAMS win the regional Science Bowl?" /></Field>
            <Field label={rules.label}><Textarea name="description" rows={3} required minLength={20} maxLength={2000} value={v.description} onChange={set("description")} placeholder={rules.placeholder} /></Field>
            <Field label="Source" hint="(where will the answer be published?)"><Input name="rules_source" maxLength={300} value={v.rules_source} onChange={set("rules_source")} placeholder="Official Science Bowl results page, or an announcement at assembly" /></Field>
            <Field label="Otherwise / edge cases" hint="(what if it's postponed, tied or unclear?)"><Textarea name="rules_otherwise" rows={2} maxLength={1000} value={v.rules_otherwise} onChange={set("rules_otherwise")} placeholder="If the event is postponed past the closing date, this resolves NO." /></Field>
            {!yesno && <Field label="Outcomes" hint="(one per line, 2–8)"><Textarea name="outcomes" rows={3} required value={outcomes} onChange={(e) => setOutcomes(e.target.value)} /></Field>}
            <div className={cn("grid gap-3 sm:grid-cols-2", showLiquidity && "xl:grid-cols-3")}>
              <Field label="Category"><NativeSelect name="category" value={v.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</NativeSelect></Field>
              <Field label="Betting closes"><Input type="datetime-local" name="closes_at" required value={v.closes_at} onChange={set("closes_at")} /></Field>
              {showLiquidity && (
                <Field label="Liquidity">
                  <NativeSelect name="liquidity" value={v.liquidity} onChange={set("liquidity")} title="Higher liquidity = prices move less per bet">
                    <option value="low">Low (prices swing fast)</option>
                    <option value="medium">Medium</option>
                    <option value="high">High (prices steady)</option>
                  </NativeSelect>
                </Field>
              )}
            </div>
            {review && (
              <Field label={`Note to ${review.proposer}`} hint="(optional, they'll see it)">
                <Input name="review_note" maxLength={500} value={v.review_note} onChange={set("review_note")} placeholder="e.g. Reworded to make the deadline clearer." />
              </Field>
            )}
            {review ? (
              <div className="flex flex-wrap gap-2">
                <Button name="decision" value="approve" disabled={pending}>Approve &amp; publish</Button>
                <ConfirmButton variant="destructive" name="decision" value="reject" noValidate title="Reject this proposal?" message={`${review.proposer} will see your note, if you wrote one.`} confirmLabel="Reject">Reject</ConfirmButton>
              </div>
            ) : (
              <Button className="h-10 w-full text-base sm:w-auto" disabled={pending}>{pending ? "Saving…" : (submitLabel ?? "Submit")}</Button>
            )}
          </>
        )}
      </ActionForm>
    </Card>
  );
  if (!preview) return form;

  const labels = outcomes.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const closesDate = v.closes_at ? new Date(v.closes_at) : null;
  const closes = closesDate && !isNaN(closesDate.getTime())
    ? closesDate.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      {form}
      <div className="space-y-4">
        <Card className="gap-2 p-4 sm:p-5" aria-live="polite">
          <h2>Preview</h2>
          <p className="text-sm text-muted-foreground">This is roughly how your market will look.</p>
          <div className="space-y-3 rounded-lg border p-3">
            <h3 className="font-semibold">{v.question.trim() || "Your question will show up here"}</h3>
            {yesno ? (
              <div className="flex items-end justify-between">
                <div><span className="text-3xl font-bold">50%</span> <span className="text-sm text-muted-foreground">chance</span></div>
                <div className="flex gap-1.5 text-sm font-semibold">
                  <span className="rounded-md bg-c0/15 px-2 py-1 text-c0">Yes 50¢</span>
                  <span className="rounded-md bg-c1/15 px-2 py-1 text-c1">No 50¢</span>
                </div>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {labels.map((name, i) => (
                  <li key={i} className="grid grid-cols-[minmax(0,8rem)_1fr_3rem] items-center gap-2 text-sm">
                    <span className="truncate">{name}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-secondary">
                      <span className="block h-full rounded-full" style={{ width: `${100 / labels.length}%`, background: `var(--c${i})` }} />
                    </span>
                    <span className="text-right font-semibold">{Math.round(100 / labels.length)}%</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1 rounded-lg bg-secondary p-3 text-sm">
              <h3 className={SMALL_HEADING}>{yesno ? "Resolves YES if" : "How the winner is decided"}</h3>
              <p>{v.description.trim() || "…"}</p>
              {v.rules_source.trim() && <><h3 className={SMALL_HEADING}>Source</h3><p>{v.rules_source.trim()}</p></>}
              {v.rules_otherwise.trim() && <><h3 className={SMALL_HEADING}>Otherwise</h3><p>{v.rules_otherwise.trim()}</p></>}
              {closes && <><h3 className={SMALL_HEADING}>Betting closes</h3><p>{closes}</p></>}
            </div>
          </div>
        </Card>
        {aside}
      </div>
    </div>
  );
}
