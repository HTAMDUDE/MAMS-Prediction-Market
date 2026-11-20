/** The app has no emails: every account gets this placeholder address (usernames are the real identity). */
export const syntheticEmail = (name: string) => `${name.trim().toLowerCase()}@users.mams.invalid`;
