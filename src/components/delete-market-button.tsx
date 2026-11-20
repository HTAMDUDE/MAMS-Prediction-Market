import { deleteAction } from "@/server/actions/admin";
import { ActionForm, ConfirmButton } from "@/components/action-form";

export function DeleteMarketButton({ marketId, open, small, block }: { marketId: number; open: boolean; small?: boolean; block?: boolean }) {
  return (
    <ActionForm action={deleteAction} className={block ? "" : "inline"}>
      <input type="hidden" name="market_id" value={marketId} />
      <ConfirmButton
        variant="destructive" size={small ? "sm" : "default"} className={block ? "w-full" : undefined}
        title="Delete this market permanently?"
        message={`${open ? "Everyone who bet gets their money back. " : "Payouts already made are kept. "}This cannot be undone.`}
        confirmLabel="Delete"
      >
        {block ? "Delete market" : "Delete"}
      </ConfirmButton>
    </ActionForm>
  );
}
