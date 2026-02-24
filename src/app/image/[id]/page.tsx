/**
 * Responsibility:
 * - Fetch an image by ID via tRPC server-side caller (no HTTP).
 * - Render the image and its tags with confidence.
 *
 * Why Server Component:
 * - Read-only view.
 * - Keeping it server-rendered avoids client JS and keeps the MVP fast.
 */

import Link from "next/link";
import { headers } from "next/headers";
import { createCaller } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { ImageActions } from "./_components/image-actions";
import { ImageDetailLayout } from "./_components/image-detail-layout";

import type { Metadata } from "next";
import { env } from "~/env";

/**
 * Next.js App Router "params" boundary helper.
 *
 * Solves (Next 15):
 * - Sometimes Next provides `params` as a Promise (async dynamic API).
 * - If `params.id` are read synchronously in those cases, Next throws:
 *   “params should be awaited before using its properties”.
 *
 * So intentionally accept both shapes:
 * - params: { id: string }
 * - params: Promise<{ id: string }>
 *
 * This keeps the page stable across Next versions and build modes.
 */
type ParamsShape = { id: string };
type PropsShape = { params: ParamsShape | Promise<ParamsShape> };

/**
 * SEO:
 * generateMetadata runs on the server before rendering.
 */
export async function generateMetadata(props: unknown): Promise<Metadata> {
  const { params } = props as PropsShape;

  const resolvedParams = await params;

  // Parse and validate id (avoid accidental crashes in metadata generation).
  const id = Number(resolvedParams.id);

  // If invalid, noindex this page and provide a stable canonical anyway.
  if (!Number.isInteger(id) || id <= 0) {
    const canonical = new URL(
      `/image/${encodeURIComponent(resolvedParams.id)}`,
      env.SITE_URL,
    );

    return {
      title: "Invalid image id",
      description: "The image id in the URL is invalid.",
      alternates: { canonical },
      robots: { index: false, follow: true },
    };
  }

  // Create server-side tRPC caller and fetch data for metadata.
  const ctx = await createTRPCContext({ headers: await headers() });
  const api = createCaller(ctx);

  let data: Awaited<ReturnType<typeof api.image.getById>> | null = null;

  try {
    data = await api.image.getById({ id });
  } catch {
    data = null;
  }

  const canonical = new URL(`/image/${id}`, env.SITE_URL);

  // If image doesn't exist, noindex it.
  if (!data) {
    return {
      title: "Image not found",
      description: `There is no image with id #${id}.`,
      alternates: { canonical },
      robots: { index: false, follow: true },
    };
  }

  const { image, tags } = data;

  // Build a stable, human-readable title.
  const topTags = tags
    .slice(0, 5)
    .map((t) => t.name)
    .filter(Boolean);

  const titleBase = image.caption?.trim()
    ? image.caption.trim()
    : topTags.length > 0
      ? topTags.slice(0, 3).join(", ")
      : `Image #${image.id}`;

  // Description is a short snippet for search results and social previews.
  const description =
    topTags.length > 0
      ? `Pepe meme image tagged: ${topTags.join(", ")}.`
      : "Pepe meme image with AI-generated tags.";

  // Only use an OG image URL if it is public and absolute.
  const candidateOg = image.renderUrl ?? image.storageKey;

  const ogImageUrl =
    typeof candidateOg === "string" &&
    (candidateOg.startsWith("https://") || candidateOg.startsWith("http://"))
      ? candidateOg
      : null;

  return {
    title: titleBase,
    description,
    alternates: { canonical },

    openGraph: {
      title: `${titleBase} | PepeFinder`,
      description,
      url: canonical,
      type: "article",
      images: ogImageUrl ? [{ url: ogImageUrl }] : undefined,
    },

    twitter: {
      card: "summary_large_image",
      title: `${titleBase} | PepeFinder`,
      description,
      images: ogImageUrl ? [ogImageUrl] : undefined,
    },

    robots: {
      index: true,
      follow: true,
    },
  };
}

export default async function ImageDetailPage(props: unknown) {
  const { params } = props as PropsShape;

  /**
   * Next 15-safe: defensive await.
   */
  const resolvedParams = await params;

  // Step 1: Parse the route param.
  const id = Number(resolvedParams.id);

  /**
   * If the URL param is not a valid positive integer,
   * avoid making a useless DB call and render a simple error state.
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

  // Step 2: Create server-side tRPC caller and fetch data.
  const ctx = await createTRPCContext({ headers: await headers() });
  const api = createCaller(ctx);

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

  /*
   * SEO
   *
   * JSON-LD structured data for ImageObject.
   */
  const canonical = new URL(`/image/${image.id}`, env.SITE_URL).toString();

  const imageUrl = image.renderUrl ?? image.storageKey;

  const keywords = tags.map((t) => t.name).filter(Boolean);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ImageObject",
    name: title,
    url: canonical,
    contentUrl: imageUrl,
    description:
      keywords.length > 0
        ? `Tags: ${keywords.slice(0, 12).join(", ")}.`
        : "Pepe meme image with AI-generated tags.",
    keywords: keywords.join(", "),
  };

  // Delegate the full rendering (image + tags layout) to a client component (Server Components cannot measure runtime layout).
  return (
    <>
      {/* SEO: JSON-LD structured data. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ImageDetailLayout
        imageStatus={image.status}
        imageId={image.id}
        title={title}
        createdAtIso={image.createdAt.toISOString()}
        imageUrl={imageUrl}
        ImageActionsSlot={<ImageActions imageId={image.id} />}
        tags={tags.map((t) => ({
          id: t.id,
          name: t.name,
          confidence: t.confidence,
        }))}
      />
    </>
  );
}
