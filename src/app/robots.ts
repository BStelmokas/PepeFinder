/**
 * robots.ts (App Router)
 *
 * Why this file exists:
 * - Next.js App Router supports generating robots.txt via a typed module.
 * - This is safer than manually placing a static file because:
 *   - it’s versioned in code
 *   - it’s easy to evolve later (e.g., staging vs prod)
 *
 * What robots.txt does (important):
 * - It is an SEO instruction for *well-behaved* crawlers (Google/Bing/etc.).
 * - It is NOT an access control or security mechanism.
 *
 * Our policy:
 * - Block crawl/index pressure on:
 *   - /api     (infra-only routes; no SEO value)
 *   - /upload  (user flow; no SEO value; potential spam target)
 *   - /search  (infinite query combinations; duplicate content / crawl budget waste)
 *
 * We deliberately do NOT block:
 * - /privacy or /takedown (trust/legal signaling pages)
 * - /image/* (your shareable content pages, if you want indexing)
 */

import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import getOrigin from "src/lib/url/get-origin";
import { env } from "~/env";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await getOrigin();
  return {
    // A single policy applying to all crawlers.
    rules: [
      {
        userAgent: "*",

        // Disallow these route prefixes (prefix-match in practice).
        // - "/api" blocks "/api" and "/api/*"
        // - "/upload" blocks "/upload" and "/upload/*"
        // - "/search" blocks "/search" and "/search/*"
        disallow: ["/api", "/upload", "/search"],

        // Everything else remains crawlable.
        allow: ["/"],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
