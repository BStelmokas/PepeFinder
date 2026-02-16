/**
 * Dynamic sitemap.xml generator (Next.js App Router).
 *
 * What a sitemap is (product-level):
 * - A sitemap is a machine-readable list of URLs you *want search engines to discover*.
 * - For PepeFinder, this matters because you have thousands of deep pages (/image/[id])
 *   that a crawler might take a long time to discover purely by following links.
 *
 * Architectural choice:
 * - We generate the sitemap from Postgres so it stays accurate as your corpus grows.
 * - We include only "indexed" images so crawlers don't waste time on pending/failed items.
 *
 * Important boundary:
 * - This is NOT a "feature API". It's an SEO artifact.
 * - It should be fast, safe, and read-only.
 */

import type { MetadataRoute } from "next";
import { sql } from "drizzle-orm"; // Used for a small, explicit where clause.
import { db } from "~/server/db"; // ✅ DB singleton (T3 rule: one exported db instance).
import { images } from "~/server/db/schema"; // ✅ Drizzle schema table definition.
import getOrigin from "src/lib/url/get-origin";

// ✅ IMPORTANT: Next.js requires this to be statically analyzable (a literal), not an expression.
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
