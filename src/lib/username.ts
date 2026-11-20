/** Accounts imported from the old Flask site have no real email; they get this placeholder (and count as verified). */
export const LEGACY_EMAIL_DOMAIN = "users.mams.invalid";
export const legacyEmail = (name: string) => `${name.trim().toLowerCase()}@${LEGACY_EMAIL_DOMAIN}`;
