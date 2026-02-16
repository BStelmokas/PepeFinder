/**
 * Minimal Reddit API client for manual batch ingestion scripts.
 *
 * This is intentionally not a service:
 * - It’s only used by offline scripts.
 * - Keep it tiny to avoid “crawler infra” creep.
 *
 * Auth model:
 * - Script app OAuth token via /api/v1/access_token
 * - Listing endpoints via oauth.reddit.com
 */

import { env } from "~/env";

/**
 * Helper to enforce that a value exists at the moment it's needed.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. This is only needed for Reddit ingestion scripts.`,
    );
  }
  return value;
}

/**
 * Get an OAuth access token using the “password” grant.
 *
 * This is acceptable here because:
 * - it’s a single operator-controlled script
 * - not a multi-user product feature
 */
export async function redditGetAccessToken(): Promise<string> {
  const clientId = requireEnv("REDDIT_CLIENT_ID", env.REDDIT_CLIENT_ID);
  const clientSecret = requireEnv(
    "REDDIT_CLIENT_SECRET",
    env.REDDIT_CLIENT_SECRET,
  );
  const username = requireEnv("REDDIT_USERNAME", env.REDDIT_USERNAME);
  const password = requireEnv("REDDIT_PASSWORD", env.REDDIT_PASSWORD);
  const userAgent = requireEnv("REDDIT_USER_AGENT", env.REDDIT_USER_AGENT);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const form = new URLSearchParams();
  form.set("grant_type", "password");
  form.set("username", username);
  form.set("password", password);

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "User-Agent": userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to get Reddit token: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  const json = (await res.json()) as unknown;

  const token = (json as any)?.access_token;
  if (typeof token !== "string" || token.length < 10) {
    throw new Error("Reddit token response missing access_token.");
  }

  return token;
}

/**
 * Minimal subset of listing post fields.
 */
export type RedditPost = {
  id: string; // base36 post id (e.g., "abc123")
  permalink: string;
  subreddit: string;
  url: string;
  title: string;
  is_self: boolean; // indicates text post; skip those
  post_hint?: string; // "image" for many image posts
};

/**
 * Fetch posts from a subreddit listing endpoint.
 *
 * Supported:
 * - /new
 * - /top (optionally with t=day/week/month/year/all)
 */
export async function redditFetchListing(params: {
  accessToken: string;
  subreddit: string;
  sort: "new" | "top";
  limit: number;
  time?: "day" | "week" | "month" | "year" | "all";
}): Promise<RedditPost[]> {
  const userAgent = requireEnv("REDDIT_USER_AGENT", env.REDDIT_USER_AGENT);

  const url = new URL(
    `https://oauth.reddit.com/r/${params.subreddit}/${params.sort}`,
  );

  // Standard listing params (Reddit “Listings” share limit/after/before/etc.).
  url.searchParams.set("limit", String(params.limit));

  // For "top", time window is controlled by "t" (optional).
  if (params.sort === "top" && params.time) {
    url.searchParams.set("t", params.time);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "User-Agent": userAgent,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Reddit listing error: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  const json = (await res.json()) as any;

  const children = json?.data?.children;
  if (!Array.isArray(children)) return [];

  const posts: RedditPost[] = [];

  for (const child of children) {
    const d = child?.data;
    if (!d) continue;

    if (typeof d.id !== "string") continue;
    if (typeof d.permalink !== "string") continue;
    if (typeof d.subreddit !== "string") continue;
    if (typeof d.url !== "string") continue;
    if (typeof d.title !== "string") continue;

    posts.push({
      id: d.id,
      permalink: d.permalink,
      subreddit: d.permalink,
      url: d.url,
      title: d.title,
      is_self: Boolean(d.is_self),
      post_hint: typeof d.post_hint === "string" ? d.post_hint : undefined,
    });
  }

  return posts;
}
