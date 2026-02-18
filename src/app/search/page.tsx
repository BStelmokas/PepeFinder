/**
 * "/search?q=..." — Search results page
 *
 * Responsibility:
 * - Parse the query string from searchParams.
 * - Call the *same* tRPC procedure used by clients, but via a server-side caller:
 *   - no HTTP
 *   - same validation/middleware
 *   - single authoritative API surface
 * - Render a responsive grid of images (thumbnails).
 *
 * Why Server Component:
 * - This is a read-only view.
 * - Rendering on the server is fast, cache-friendly later, and avoids client JS.
 */

import Link from "next/link";
import { headers } from "next/headers";
import { createCaller } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

/**
 * The shape Next provides for the resolved search params object.
 *
 * Why this type:
 * - Next keys map to string | string[] | undefined.
 */
type ResolvedSearchParams = Record<string, string | string[] | undefined>;

type SearchCursorUrlShape = {
  matchCount: number | string;
  createdAtMs: number | string; // ISO string in URL payload
  id: number | string;
};

function encodeCursor(cursor: {
  matchCount: number;
  createdAtMs: number;
  id: number;
}): string {
  // base64url avoids "+" and "/" which are difficult in URLs.
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  raw: string | undefined,
): { matchCount: number; createdAtMs: number; id: number } | undefined {
  if (!raw) return undefined;

  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<SearchCursorUrlShape>;

    /**
     * The cursor payload may contain numeric fields encoded as strings,
     * because matchCount comes from SQL COUNT() and can be string at runtime.
     *
     * So coerce aggressively but safely.
     *
     * IMPORTANT:
     * `parsed` is a Partial<...>, fields may be missing (undefined).
     * So coerce missing fields to NaN to validate with Number.isFinite.
     */
    const matchCountRaw = parsed.matchCount;
    const createdAtMsRaw = parsed.createdAtMs;
    const idRaw = parsed.id;

    const matchCount =
      typeof matchCountRaw === "string"
        ? Number(matchCountRaw)
        : typeof matchCountRaw === "number"
          ? matchCountRaw
          : Number.NaN;

    const createdAtMs =
      typeof createdAtMsRaw === "string"
        ? Number(createdAtMsRaw)
        : typeof createdAtMsRaw === "number"
          ? createdAtMsRaw
          : Number.NaN;

    const id =
      typeof idRaw === "string"
        ? Number(idRaw)
        : typeof idRaw === "number"
          ? idRaw
          : Number.NaN;

    if (
      !Number.isFinite(matchCount) ||
      !Number.isFinite(createdAtMs) ||
      Number.isNaN(id)
    ) {
      return undefined;
    }

    return { matchCount, createdAtMs, id };
  } catch {
    return undefined;
  }
}

function parseIntParam(
  raw: string | string[] | undefined,
  fallback: number,
): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default async function SearchPage(props: {
  searchParams?: Promise<ResolvedSearchParams>;
}) {
  /**
   * IMPORTANT:
   * In newer Next.js App Router versions, `searchParams` is typed as Promise<any>
   * at the framework boundary.
   *
   * Accept an untyped boundary and narrow immediately.
   */
  const searchParams: ResolvedSearchParams = (await props.searchParams) ?? {};

  /**
   * Step 1: Read q from the URL.
   * - searchParams values can be string | string[] | undefined in Next.
   */
  const rawQ = searchParams.q;
  const q = Array.isArray(rawQ) ? rawQ.join(" ") : (rawQ ?? "");

  // Read "cursor" from URL, decode it into the typed cursor shape expected by tRPC (Date included).
  const rawCursor = searchParams.cursor;
  const cursorToken = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
  const cursor = decodeCursor(cursorToken);

  const shownBefore = parseIntParam(searchParams.shown, 0);

  // Step 2: Create a server-side tRPC caller.
  const ctx = await createTRPCContext({ headers: await headers() });
  const api = createCaller(ctx);
  type SearchImagesOutput = Awaited<ReturnType<typeof api.search.searchImages>>;

  const pageSize = 48;

  /**
   * Step 3: Execute the search via tRPC.
   *
   * Hits the DB-only search procedure and returns:
   * - id
   * - storageKey
   * - createdAt
   * - matchCount
   */
  const results: SearchImagesOutput = await api.search.searchImages({
    q,
    limit: pageSize,
    cursor,
  });

  // Encode nextCursor back into URL token form for the "Next" link.
  const nextCursorToken = results.nextCursor
    ? encodeCursor(results.nextCursor)
    : null;

  // Cumulative “shown so far”:
  const shownSoFarRaw = shownBefore + results.items.length;
  const shownSoFar = Math.min(shownSoFarRaw, results.totalCount);

  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* Header row: title + small query context */}
        <h1 className="ml-1 text-2xl font-semibold text-gray-900">
          Search results
        </h1>
        <div className="mt-5 flex items-center justify-between gap-5">
          <div className="inline-flex w-fit max-w-[calc(100%-7rem)] items-center rounded-xl border border-gray-200 bg-white px-4 py-2 shadow-sm">
            <p className="text-sm text-gray-600">
              Query:{" "}
              <span className="font-medium wrap-break-word text-gray-900">
                {q.trim() === "" ? "(empty)" : q}
              </span>
            </p>
          </div>

          {/* Back to home for quick re-searching. */}
          <Link
            href="/"
            className="inline-flex w-fit shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Search
          </Link>
        </div>

        {/* Result summary */}
        <div className="mt-4 flex">
          <div className="w-fit rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-gray-700">
              {results.totalCount} result{results.totalCount === 1 ? "" : "s"}{" "}
              (ranked by tag overlap)
            </p>

            <p className="mt-1 text-xs text-gray-500">
              Showing {shownSoFar} of {results.totalCount}
            </p>
          </div>
        </div>

        {/* Grid */}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {results.items.map((r) => (
            <Link
              key={r.id}
              href={`/image/${r.id}`}
              className="group rounded-2xl border border-gray-200 bg-white shadow-sm hover:shadow-md"
            >
              {/* Thumbnail area */}
              <div className="aspect-square overflow-hidden rounded-2xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.renderUrl ?? r.storageKey}
                  alt={`Pepe image ${r.id}`}
                  className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                  loading="lazy"
                />
              </div>

              {/* Metadata */}
              <div className="p-3">
                <div className="flex items-center justify-center">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                    Matches: {r.matchCount} tag{r.matchCount > 1 ? "s" : ""}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-8 flex items-center justify-end">
          {nextCursorToken ? (
            <Link
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
              href={`/search?q=${encodeURIComponent(q)}&cursor=${encodeURIComponent(nextCursorToken)}&shown=${encodeURIComponent(shownSoFar)}`}
            >
              Next →
            </Link>
          ) : (
            ""
          )}
        </div>

        {/* Empty state */}
        {results.items.length === 0 && (
          <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <p className="text-sm text-gray-700">
              No matches. Try different wording.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
