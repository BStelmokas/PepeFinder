"use client";

/**
 * ImageDetailLayout (Client Component)
 *
 * Behavior:
 * 1) Image panel remains natural size (its height is never forced).
 * 2) Tags panel is forced to exactly that height.
 * 3) Tags list scrolls internally if it exceeds available height.
 */

import Link from "next/link";
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type TagRow = {
  id: number;
  name: string;
  confidence: number;
};

export function ImageDetailLayout(props: {
  imageStatus: "pending" | "indexed" | "failed";
  imageId: number;
  title: string;
  createdAtIso: string;
  imageUrl: string;
  tags: TagRow[];
  ImageActionsSlot: React.ReactNode;
}) {
  const imageCardRef = useRef<HTMLDivElement | null>(null);

  /**
   * tagsCardHeightPx is applied as an inline style:
   * - null = don't clamp
   * - number = clamp tags card height exactly
   */
  const [tagsCardHeightPx, setTagsCardHeightPx] = useState<number | null>(null);

  // Measure and store the current image card height.
  function syncTagsHeightToImage(): void {
    const el = imageCardRef.current;
    if (!el) return;

    // offsetHeight includes padding + border → matches what users perceive as “card height”.
    const next = el.offsetHeight;

    // Avoid unnecessary state updates; reduces re-render churn.
    setTagsCardHeightPx((prev) => (prev === next ? prev : next));
  }

  /**
   * useLayoutEffect gives a measurement ASAP after first render
   * (before the browser paints), reducing visible “jump”.
   */
  useLayoutEffect(() => {
    syncTagsHeightToImage();
  }, []);

  // Keep height in sync as layout changes.
  useEffect(() => {
    const el = imageCardRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      syncTagsHeightToImage();
    });

    ro.observe(el);

    const onResize = () => syncTagsHeightToImage();
    window.addEventListener("resize", onResize);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const createdAtLabel = useMemo(() => {
    return new Date(props.createdAtIso).toLocaleString();
  }, [props.createdAtIso]);

  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* Top navigation */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Home
          </Link>

          {props.imageStatus === "indexed" ? (
            <Link
              href="/upload"
              className="rounded-xl bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white shadow-sm hover:bg-gray-800"
            >
              Upload
            </Link>
          ) : (
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              status: {props.imageStatus}
            </span>
          )}
        </div>

        {/* Main content: image + tag sidebar */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr] lg:items-start">
          {/* Image card (natural height) */}
          <div
            ref={imageCardRef}
            className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
          >
            <div className="flex items-center justify-between gap-x-4">
              <h1 className="ml-1 text-lg font-semibold text-gray-900">
                {props.title}
              </h1>

              <p className="mr-1 text-xs text-gray-500">{createdAtLabel}</p>
            </div>

            <div className="relative mt-4 overflow-hidden rounded-2xl border border-gray-200">
              {props.ImageActionsSlot}

              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={props.imageUrl}
                alt={`Pepe image ${props.imageId}`}
                className="h-auto w-full object-contain"
                // When the image finishes loading, its final height may differ.
                // Sync again immediately to avoid “tags card mismatch”.
                onLoad={() => syncTagsHeightToImage()}
              />
            </div>
          </div>

          {/* Tags card (always height-matched to image card) */}
          <aside
            className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
            // Force tags panel to match image panel height when a measurement exists.
            style={tagsCardHeightPx ? { height: tagsCardHeightPx } : undefined}
          >
            {/* Flex column layout so header stays fixed and list becomes scrollable */}
            <div className="flex h-full flex-col">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  Tags ({props.tags.length})
                </h2>

                <p className="mt-1 text-xs text-gray-500">
                  Ordered by confidence
                </p>
              </div>

              {/* Scroll region */}
              <div className="mt-4 min-h-0 flex-1 overflow-auto pr-1">
                {props.tags.length === 0 ? (
                  <div className="rounded-2xl bg-gray-50 p-4">
                    <p className="text-sm text-gray-700">
                      No tags yet. The image has been accepted, once the tags
                      are produced, it will be listed.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {props.tags.map((t) => (
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
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
