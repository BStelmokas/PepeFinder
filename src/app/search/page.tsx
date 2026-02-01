/**
 * "/search?q=..." — Search results page (MVP0)
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
 *
 * Important MVP assumption:
 * - images.storageKey is directly renderable as an <img src="...">.
 *   We'll replace this with S3 signed URLs in MVP1.
 */

import Link from "next/link"; // Next Link gives fast client navigation while still being Server Component friendly.
import { headers } from "next/headers"; // Provides request headers (we’ll use it for creating the tRPC context).
import { createCaller } from "~/server/api/root"; // Typed server-side tRPC caller factory.
import { createTRPCContext } from "~/server/api/trpc"; // Context builder used by tRPC middleware (even in server calls).

/**
 * The shape Next provides for the resolved search params object.
 *
 * Why this type:
 * - Next keys map to string | string[] | undefined.
 * - We want deterministic parsing logic for q.
 */
type ResolvedSearchParams = Record<string, string | string[] | undefined>;

export default async function SearchPage(props: {
  searchParams?: Promise<ResolvedSearchParams>;
}) {
  /**
   * IMPORTANT:
   * In newer Next.js App Router versions, `searchParams` is typed as Promise<any>
   * at the framework boundary.
   *
   * We accept an untyped boundary and narrow immediately.
   */
  const searchParams: ResolvedSearchParams = (await props.searchParams) ?? {};

  /**
   * Step 1: Read q from the URL.
   *
   * Why so defensive?
   * - searchParams values can be string | string[] | undefined in Next.
   * - We want deterministic behavior, not “it worked sometimes”.
   */
  const rawQ = searchParams.q;
  const q = Array.isArray(rawQ) ? rawQ.join(" ") : (rawQ ?? "");

  /**
   * Step 2: Create a server-side tRPC caller.
   *
   * This is the “no HTTP” path:
   * - We still go through the *exact* same procedures and middleware.
   * - We avoid duplicating validation/auth logic in pages.
   *
   * The caller needs a context.
   * In T3, context is typically built with request headers (for cookies/session, etc.).
   * Even though MVP0 has no auth, using the standard path keeps architecture consistent.
   */
  const ctx = await createTRPCContext({ headers: await headers() });
  const api = createCaller(ctx);

  /**
   * ============================================================
   * CHANGE HERE (typing fix: no `any`, Vercel-safe)
   * ------------------------------------------------------------
   * We derive the output type from the procedure itself.
   *
   * Why:
   * - Avoids (r as any) which breaks strict lint/typecheck in Vercel.
   * - Keeps types in sync automatically if the procedure output changes.
   *
   * How it works:
   * - `typeof api.search.searchImages` is the actual function type.
   * - `ReturnType<...>` gives the promise type.
   * - `Awaited<...>` unwraps the promise into the actual output.
   * ============================================================
   */
  type SearchImagesOutput = Awaited<ReturnType<typeof api.search.searchImages>>;

  /**
   * Step 3: Execute the search via tRPC.
   *
   * This hits our DB-only search procedure and returns:
   * - id
   * - storageKey
   * - createdAt
   * - matchCount
   */
  const results: SearchImagesOutput = await api.search.searchImages({ q });

  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* Header row: title + small query context */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              Search results
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              Query:{" "}
              <span className="font-medium text-gray-900">
                {q.trim() === "" ? "(empty)" : q}
              </span>
            </p>
          </div>

          {/* Back to home for quick re-searching (keeps MVP flow obvious). */}
          <Link href="/" className="text-sm text-gray-700 hover:text-gray-900">
            ← New search
          </Link>
        </div>

        {/* Result summary */}
        <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-700">
            {results.length} result{results.length === 1 ? "" : "s"} (ranked by
            distinct tag overlap)
          </p>
        </div>

        {/* Grid */}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {results.map((r) => (
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
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">#{r.id}</p>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                    match {r.matchCount}
                  </span>
                </div>

                <p className="mt-2 text-xs text-gray-500">
                  {new Date(r.createdAt).toLocaleString()}
                </p>
              </div>
            </Link>
          ))}
        </div>

        {/* Empty state */}
        {results.length === 0 && (
          <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <p className="text-sm text-gray-700">
              No matches. Try fewer words or different tags.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
