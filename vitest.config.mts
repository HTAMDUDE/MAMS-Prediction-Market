import path from "node:path";
import "dotenv/config";
import { defineConfig } from "vitest/config";

const testUrl = process.env.TEST_DATABASE_URL ?? "postgresql://mams:mams@localhost:5433/mams_test";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false, // every suite shares one Postgres test database
    testTimeout: 30000,
    env: {
      DATABASE_URL: testUrl,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
      BETTER_AUTH_URL: "http://localhost:3000",
      MAMS_OWNER: "", // tests assume the first account is the owner, as on a fresh site with no MAMS_OWNER
      MAMS_ADMINS: "",
    },
  },
});
