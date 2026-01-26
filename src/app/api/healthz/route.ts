/**
 * GET /api/healthz
 *
 * Infra-only health check.
 *
 * Responsibilities:
 * - Prove the server process is alive.
 * - Prove the database connection works.
 *
 * Explicit non-goals:
 * - No business logic.
 * - No tRPC.
 * - No auth.
 * - No caching.
 *
 * Why a route handler (not tRPC)?
 * - Health checks are infrastructure concerns.
 * - They must stay stable even if the app API evolves.
 */

import { NextResponse } from "next/server"; // Canonical Next.js response helper for Route Handlers.
import { db } from "~/server/db"; // Single Drizzle DB instance (globalThis-cached in dev).
import { sql } from "drizzle-orm"; // Used to run a trivial raw SQL query.

export async function GET() {
  try {
    /**
     * Trivial DB round-trip.
     *
     * Why `SELECT 1`?
     * - Fast
     * - No table access
     * - Validates:
     *   - DB connection
     *   - credentials
     *   - network
     *   - Postgres responsiveness
     *
     * If this fails, the instance should be considered unhealthy.
     */
    await db.execute(sql`SELECT 1`);

    /**
     * Success response:
     * - HTTP 200
     * - tiny JSON body
     *
     * Keep it minimal so:
     * - monitors are fast
     * - response shape is stable forever
     */
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    /**
     * Failure path:
     * - Any exception here means the instance is not healthy enough to serve traffic.
     *
     * We intentionally:
     * - do NOT leak error details (security / noise)
     * - do NOT retry
     * - do NOT throw (we control the response explicitly)
     */
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
