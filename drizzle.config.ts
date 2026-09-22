import { defineConfig } from "drizzle-kit";
import "dotenv/config";

// Wired up in gate 4 (db/). Present now so the toolchain is complete and
// `pnpm run db:generate` fails with a clear "no schema yet" rather than
// "command not found" if run early.
export default defineConfig({
  dialect: "postgresql",
  schema: "./api/app/db/schema.ts",
  out: "./api/app/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
