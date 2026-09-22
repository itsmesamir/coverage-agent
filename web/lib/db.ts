/**
 * Read-only database access for the dashboard.
 *
 * The dashboard deliberately does not import `api/app/db`. Two reasons: the app
 * layer is compiled under `module: NodeNext` while Next resolves with a bundler,
 * and — more importantly — a read-only client means no view in this directory
 * can mutate a negotiation. The dashboard observes; it never decides.
 */

import "server-only";
import { config } from "dotenv";
import path from "node:path";
import postgres from "postgres";

// `next dev web` runs from the repository root, `next start` from `web/`.
// dotenv does not overwrite variables that are already set, so loading both
// candidates resolves either layout without knowing which one we are in.
config({ path: path.join(process.cwd(), ".env"), quiet: true });
config({ path: path.join(process.cwd(), "..", ".env"), quiet: true });

declare global {
  // Next re-evaluates modules on every hot reload. Without a cached handle that
  // leaks a connection pool per edit until Postgres refuses new clients.
  var __coverageAgentSql: ReturnType<typeof postgres> | undefined;
}

/**
 * Connects on first query, not on import. `next build` evaluates page modules
 * to collect route configuration, and a build machine has no database.
 */
export function sql(): ReturnType<typeof postgres> {
  const existing = globalThis.__coverageAgentSql;
  if (existing) return existing;

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");

  const client = postgres(url, { max: 4, onnotice: () => {} });
  globalThis.__coverageAgentSql = client;
  return client;
}
