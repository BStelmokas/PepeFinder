/**
 * Why this file exists:
 * - Next.js App Router supports generating robots.txt via a typed module.
 * - This is safer than manually placing a static file because:
 *   - it’s versioned in code
 *   - it’s easy to evolve later (e.g., staging vs prod)
 *
 * What robots.txt does (important):
 * - It is an SEO instruction for *well-behaved* crawlers (Google/Bing/etc.).
 *
 * Policy:
 * - Block crawl/index pressure on:
 *   - /api     (infra-only routes; no SEO value)
 *   - /upload  (user flow; no SEO value; potential spam target)
 *   - /search  (infinite query combinations; duplicate content / crawl budget waste)
 *
 * Deliberately do NOT block:
 * - /privacy or /takedown (trust/legal signaling pages)
 * - /image/* (shareable content pages)
 */

import type { MetadataRoute } from "next";
import getOrigin from "src/lib/url/get-origin";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await getOrigin();
  return {
    // A single policy applying to all crawlers.
    rules: [
      {
        userAgent: "*",
        disallow: ["/api", "/upload", "/search"],
        allow: ["/"],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
