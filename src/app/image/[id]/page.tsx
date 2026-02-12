/**
 * "/image/[id]" — Image detail page (MVP0)
 *
 * Responsibility:
 * - Fetch an image by ID via tRPC server-side caller (no HTTP).
 * - Render the image and its tags with confidence.
 *
 * Why Server Component:
 * - Read-only view.
 * - Keeping it server-rendered avoids client JS and keeps the MVP fast.
 *
 * MVP assumption:
 * - image.storageKey is directly usable as <img src="...">.
 */

import Link from "next/link"; // Used for navigation back to search/home.
import { headers } from "next/headers"; // Used to build tRPC context in the server caller path.
import { createCaller } from "~/server/api/root"; // Typed server-side tRPC caller factory.
import { createTRPCContext } from "~/server/api/trpc"; // Context builder that preserves middleware invariants.

/**
 * Next.js App Router "params" boundary helper.
 *
 * Problem we’re solving (Next 15):
 * - Sometimes Next provides `params` as a Promise (async dynamic API).
 * - If we read `params.id` synchronously in those cases, Next throws:
 *   “params should be awaited before using its properties”.
 *
 * So we intentionally accept both shapes:
 * - params: { id: string }
 * - params: Promise<{ id: string }>
 *
 * This keeps the page stable across Next versions and build modes.
 */
type ParamsShape = { id: string };
type PropsShape = { params: ParamsShape | Promise<ParamsShape> };

export default async function ImageDetailPage(props: unknown) {
  /**
   * IMPORTANT:
   * We intentionally accept an untyped boundary and narrow immediately.
   *
   * Fix (Next 15):
   * - `params` might be a Promise, so we `await` it defensively.
   */
  const { params } = props as PropsShape;

  /**
   * Next 15-safe: always await, even if params is already a plain object.
   * - `await` works on non-Promises too (it simply returns the value).
   * - That makes this line the simplest cross-version compatibility trick.
   */
  const resolvedParams = await params;

  /**
   * Step 1: Parse the route param.
   *
   * Route params are strings in Next.js.
   * Our DB uses integer IDs, so we convert carefully.
   */
  const id = Number(resolvedParams.id);

  /**
   * If the URL param is not a valid positive integer,
   * we avoid making a useless DB call and render a simple error state.
   */
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <main className="min-h-screen bg-white">
        <div className="mx-auto max-w-4xl px-6 py-10">
          <Link
            href="/"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Search
          </Link>
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <h1 className="text-lg font-semibold text-gray-900">
              Invalid image id
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              The URL must be a positive integer.
            </p>
          </div>
        </div>
      </main>
    );
  }

  /**
   * Step 2: Create server-side tRPC caller and fetch data.
   */
  const ctx = await createTRPCContext({ headers: await headers() });
  const api = createCaller(ctx);

  /**
   * This procedure throws NOT_FOUND if the image does not exist.
   * In MVP0, we keep error handling simple and show an inline state.
   */
  let data: Awaited<ReturnType<typeof api.image.getById>> | null = null;

  try {
    data = await api.image.getById({ id });
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-white">
        <div className="mx-auto max-w-4xl px-6 py-10">
          <Link
            href="/"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Search
          </Link>
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <h1 className="text-lg font-semibold text-gray-900">
              Image not found
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              There is no image with id{" "}
              <span className="font-medium">#{id}</span>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const { image, tags } = data;

  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* Top navigation */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Search
          </Link>

          {/* STEP CHANGE:
              Replace the redundant "status: indexed" pill with an Upload button.
              Keep the status pill for pending/failed, because those are meaningful states. */}
          {image.status === "indexed" ? (
            <Link
              href="/upload"
              className="rounded-xl bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white shadow-sm hover:bg-gray-800"
            >
              Upload
            </Link>
          ) : (
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              status: {image.status}
            </span>
          )}
        </div>

        {/* Main content: image + tag sidebar */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr] lg:items-start">
          {/* Image card */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h1 className="ml-1 text-lg font-semibold text-gray-900">
                {image.caption}
              </h1>

              <p className="mr-1 text-xs text-gray-500">
                {new Date(image.createdAt).toLocaleString()}
              </p>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.renderUrl ?? image.storageKey}
                alt={`Pepe image ${image.id}`}
                className="h-auto w-full object-contain"
              />
            </div>

            {/* Minimal metadata block */}
            {/* <div className="mt-4 rounded-2xl bg-gray-50 p-4">
              <p className="text-xs text-gray-600">
                <span className="font-medium text-gray-800">sha256:</span>{" "}
                <span className="font-mono">{image.sha256}</span>
              </p>

              {(image.source ?? image.sourceRef) && (
                <p className="mt-2 text-xs text-gray-600">
                  <span className="font-medium text-gray-800">source:</span>{" "}
                  {image.source ?? "-"}{" "}
                  {image.sourceRef ? (
                    <>
                      <span className="text-gray-400">·</span>{" "}
                      <span className="break-all">{image.sourceRef}</span>
                    </>
                  ) : null}
                </p>
              )}
            </div> */}
          </div>

          {/* Tags card */}
          <aside className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">
              Tags ({tags.length})
            </h2>

            <p className="mt-1 text-xs text-gray-500">Ordered by confidence</p>

            <div className="mt-4 space-y-2">
              {tags.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-3 py-2"
                >
                  <span className="text-sm font-medium text-gray-900">
                    {t.name}
                  </span>

                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                    {t.confidence.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>

            {tags.length === 0 && (
              <div className="mt-6 rounded-2xl bg-gray-50 p-4">
                <p className="text-sm text-gray-700">
                  No tags yet. The image has been accepted, once the tags are
                  produced, it will be listed.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
