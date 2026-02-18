/**
 * GET /api/healthz
 *
 * Infra-only health check.
 *
 * Responsibilities:
 * - Prove the server process is alive.
 * - Prove the database connection works.
 */

import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    /**
     * Trivial DB round-trip.
     * If this fails, the instance should be considered unhealthy.
     */
    await db.execute(sql`SELECT 1`);

    /**
     * Success response:
     * - HTTP 200
     * - tiny JSON body
     */
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    /**
     * Failure path:
     * - Any exception here means the instance is not healthy enough to serve traffic.
     */
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
