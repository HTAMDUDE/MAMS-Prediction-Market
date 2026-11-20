/**
 * Give a user a new temporary password and print it:  pnpm reset-password <username>
 * This is the way back in after importing old accounts (nobody can log in yet), and a fallback if every admin is locked out.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { findUserIdByUsername, setTemporaryPassword } from "../src/server/password";

async function main() {
  const username = process.argv[2];
  if (!username) throw new Error("Usage: pnpm reset-password <username>");
  const password = await setTemporaryPassword(await findUserIdByUsername(username));
  console.log(`Temporary password for ${username}: ${password}`);
  console.log("Share it privately. They can change it on their Portfolio page.");
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
