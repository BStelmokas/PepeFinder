import { headers } from "next/headers";
import { env } from "~/env";

/**
 * Determine the canonical origin to use for absolute URLs.
 *
 * Priority order:
 * 1) env.SITE_URL (best for production; stable and intentional)
 * 2) request headers (useful for preview deployments)
 * 3) localhost (last resort for dev / misconfigured environments)
 */
export default async function getOrigin(): Promise<string> {
  // 1) Canonical origin (production).
  // Normalize by removing a trailing slash to prevent double slashes in URLs.
  if (env.SITE_URL) {
    return env.SITE_URL.replace(/\/+$/, "");
  }

  // 2) Derive from request headers (works in many environments, including Vercel previews).
  const h = await headers();

  // Prefer proxy-provided scheme if present; otherwise default to https in production-like contexts.
  const proto = h.get("x-forwarded-proto") ?? "https";

  // Host header should be present for normal HTTP requests.
  const host = h.get("host");

  if (!host) {
    // If host is missing, no correct absolute URL exists.
    // Fail closed by returning a sensible default for local dev.
    return "http:/localhost:3000";
  }

  return `${proto}://${host}`;
}
