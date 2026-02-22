/**
 * Dynamic sitemap.xml generator.
 *
 * This is a machine-readable list of URLs *desirable for search engines to discover*.
 *
 * Architectural choice:
 * - Generate the sitemap from Postgres so it stays accurate as the corpus grows.
 * - Include only "indexed" images so crawlers don't waste time on pending/failed items.
 */

import type { MetadataRoute } from "next";
import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { images } from "~/server/db/schema";
import getOrigin from "src/lib/url/get-origin";

// IMPORTANT: Next.js requires this to be statically analyzable (a literal), not an expression.
export const revalidate = 3600; // Re-generate at most once per hour

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await getOrigin();

  // Only include indexed images so crawlers don't waste time on pending/failed content.
  const rows = await db
    .select({
      id: images.id,
      updatedAt: images.updatedAt,
    })
    .from(images)
    .where(sql`${images.status} = 'indexed'`)
    .orderBy(images.id);

  const out: MetadataRoute.Sitemap = [
    { url: `${origin}/` },
    { url: `${origin}/privacy` },
    { url: `${origin}/takedown` },
  ];

  for (const r of rows) {
    out.push({
      url: `${origin}/image/${r.id}`,
      lastModified: r.updatedAt ?? undefined,
    });
  }

  return out;
}
