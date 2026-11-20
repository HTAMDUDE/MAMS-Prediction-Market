import { execSync } from "node:child_process";

/** Apply migrations to the test database once per run (non-destructive; tests truncate their own tables). Never point TEST_DATABASE_URL at real data. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://mams:mams@localhost:5433/mams_test";
  if (!/test/i.test(new URL(url).pathname)) throw new Error("TEST_DATABASE_URL must point at a database with 'test' in its name.");
  execSync("pnpm prisma migrate deploy", {
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });
}
