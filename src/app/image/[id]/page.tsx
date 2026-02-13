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
// STEP FLAG/DOWNLOAD CHANGE: client component for Download + Flag actions.
import { ImageActions } from "./_components/image-actions";

// STEP 99 CHANGE: new client layout component that syncs tags height to image height (on ALL devices).
import { ImageDetailLayout } from "./_components/image-detail-layout";

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

  // Small UX fallback: some images may not have been captioned yet.
  const title = image.caption?.trim()
    ? image.caption.trim()
    : `Image #${image.id}`;

  /**
   * STEP 99 CHANGE:
   * We delegate the full rendering (image + tags layout) to a client component.
   *
   * Why this is required:
   * - Your rule is “tags panel height must match image panel height, on ALL devices”.
   * - This requires runtime DOM measurement.
   * - Server Components cannot measure runtime layout.
   */
  return (
    <ImageDetailLayout
      imageStatus={image.status}
      imageId={image.id}
      title={title}
      createdAtIso={image.createdAt.toISOString()}
      imageUrl={image.renderUrl ?? image.storageKey}
      ImageActionsSlot={<ImageActions imageId={image.id} />}
      tags={tags.map((t) => ({
        id: t.id,
        name: t.name,
        confidence: t.confidence,
      }))}
    />
  );
}
