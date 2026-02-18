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

    // Fetch bytes server-side.
    // For large files, streaming is better, but Pepe images are small so buffering keeps code simple.
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

    const bytes = await upstream.arrayBuffer();

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

    // Return with attachment header to force download.
    return new NextResponse(bytes, {
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
