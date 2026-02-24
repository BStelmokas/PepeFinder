/**
 * GET /api/images/[id]/download
 *
 * Responsibility (infra-only):
 * - Provide a reliable “download” endpoint that forces Content-Disposition: attachment.
 *
 * Why this is needed:
 * - Direct S3/R2 public URLs often open in a new tab instead of downloading.
 * - The HTML `download` attribute is not consistently honored cross-origin.
 *
 * This route:
 * - Looks up the image in Postgres (DB = source of truth for storage key)
 * - Resolves a fetchable URL (public or presigned) using the existing storage resolver
 * - Fetches bytes server-side
 * - Responds with headers that force download
 */

import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { images } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { resolveImageUrlForBrowser } from "~/server/storage/resolve-image-url";
import { env } from "~/env";

/**
 * Allowlist where this route is permitted to fetch from.
 *
 * Only allow server-side fetches from trusted storage hosts.
 * Prevents this endpoint from becoming an open proxy (SSRF risk) if storageKey is ever compromised.
 */
function isAllowedUpstreamUrl(fetchUrl: string): boolean {
  try {
    const u = new URL(fetchUrl);

    // Always require http(s) to avoid weird schemes.
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;

    // Best case: configured public base URL for the bucket.
    if (env.S3_PUBLIC_BASE_URL) {
      const base = new URL(env.S3_PUBLIC_BASE_URL);
      if (u.host === base.host && u.protocol === base.protocol) {
        return true;
      }
    }

    // If no public base URL, still allow the S3 endpoint host.
    if (env.S3_ENDPOINT) {
      const endpoint = new URL(env.S3_ENDPOINT);
      if (u.host === endpoint.host) {
        return true;
      }
    }

    // Legacy allowlist.
    const legacyAllowedHosts = new Set([
      "i.redd.it",
      "preview.redd.it",
      "i.imgur.com",
      "i.pinimg.com",
    ]);

    if (legacyAllowedHosts.has(u.host)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;

    // Parse id.
    const imageId = Number(id);

    if (!Number.isInteger(imageId) || imageId <= 0) {
      return NextResponse.json(
        { ok: false, error: "Invalid id" },
        { status: 400 },
      );
    }

    // Fetch the minimum info needed to download.
    const rows = await db
      .select({
        storageKey: images.storageKey,
        caption: images.caption,
      })
      .from(images)
      .where(eq(images.id, imageId))
      .limit(1);

    const row = rows[0];

    if (!row) {
      return NextResponse.json(
        { ok: false, error: "Not found" },
        { status: 404 },
      );
    }

    // Resolve to a URL that can be fetched from the server.
    const fetchUrl = await resolveImageUrlForBrowser(row.storageKey);

    // Enforce allowlist before fetching (SSRF hardening).
    if (!isAllowedUpstreamUrl(fetchUrl)) {
      return NextResponse.json(
        { ok: false, error: "Blocked upstream host" },
        { status: 400 },
      );
    }

    // Fetch from upstream.
    const upstream = await fetch(fetchUrl);

    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Upstream fetch failed: ${upstream.status}`,
        },
        { status: 502 },
      );
    }

    const contentType =
      upstream.headers.get("content-type")?.split(";")[0]?.trim() ??
      "application/octet-stream";

    // Build a friendly filename.
    // Sanitize heavily because captions can contain punctuation and non-filename characters.
    const baseName = row.caption?.trim()
      ? row.caption.trim()
      : `pepe-${imageId}`;

    const safeName = baseName
      .replace(/[^a-zA-Z0-9-_ ]+/g, "") // drop odd characters
      .trim()
      .replace(/\s+/g, "-"); // spaces -> hyphens

    // The extension isn't always known, but browsers use content-type anyway.
    const filename = `${safeName || `pepe-${imageId}`}.jpg`;

    // Stream the response body, return with attachment header to force download.
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Cache policy: safe to allow caching, but keep conservative.
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
