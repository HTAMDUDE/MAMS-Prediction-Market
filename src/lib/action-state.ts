/** What a form action returns to the page; null before the first submit. `persist` keeps the toast on screen longer. */
export type ActionState = { ok: boolean; message: string; persist?: boolean } | null;
