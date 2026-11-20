/**
 * Give a user a new temporary password, mark their email verified, and print the password:  pnpm reset-password <username>
 * This is the way back in after importing old accounts (nobody can log in yet), and the fallback if the owner is locked
 * out (forgotten password, or an email that was mistyped so it can't be verified).
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { findUserIdByUsername, setTemporaryPassword } from "../src/server/password";

async function main() {
  const username = process.argv[2];
  if (!username) throw new Error("Usage: pnpm reset-password <username>");
  const password = await setTemporaryPassword(await findUserIdByUsername(username), { markVerified: true });
  console.log(`Temporary password for ${username}: ${password} (email marked verified)`);
  console.log("Share it privately. They can change it on their Portfolio page.");
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
