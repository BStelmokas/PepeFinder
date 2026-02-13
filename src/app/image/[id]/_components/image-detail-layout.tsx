"use client";

/**
 * ImageDetailLayout (Client Component)
 *
 * New requirement:
 * - The tags panel must match the rendered height of the image panel on ALL devices,
 *   even in 1-column layout, to prevent very tall pages.
 *
 * Behavior:
 * 1) Image panel remains natural size (we never force its height).
 * 2) Tags panel is forced to exactly that height.
 * 3) Tags list scrolls internally if it exceeds available height.
 *
 * Implementation strategy:
 * - Measure the image card's rendered height (offsetHeight).
 * - Apply that height to the tags card via inline style.
 * - Use a flex column layout in the tags card so header stays fixed and list scrolls.
 * - Re-measure on:
 *   - image load (final intrinsic height becomes known)
 *   - ResizeObserver events (layout changes, font load, responsive width changes)
 *   - window resize (orientation changes etc.)
 *
 * Why not pure CSS:
 * - CSS cannot reliably say “set sibling height equal to this element’s intrinsic-height-driven size”
 *   when that size depends on an image’s aspect ratio and responsive width.
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
  /**
   * We measure the image card’s rendered height.
   * We do NOT measure the <img> directly because:
   * - the card includes header + padding which also influences “visual matching”
   * - you asked “div containing the image” vs “div containing tags” —
   *   this is the closest, most stable UI concept.
   *
   * If you instead want ONLY the image box (excluding title/date),
   * move this ref to the image container div below.
   */
  const imageCardRef = useRef<HTMLDivElement | null>(null);

  /**
   * tagsCardHeightPx is applied as an inline style:
   * - null = don't clamp (we try very hard not to be null, but it can be during first paint)
   * - number = clamp tags card height exactly
   */
  const [tagsCardHeightPx, setTagsCardHeightPx] = useState<number | null>(null);

  /**
   * Measure and store the current image card height.
   *
   * We keep this in a function because we call it from multiple places:
   * - layout effect (initial measurement)
   * - ResizeObserver callbackj
   * - window resize handler
   * - image onLoad
   */
  function syncTagsHeightToImage(): void {
    const el = imageCardRef.current;
    if (!el) return;

    // offsetHeight includes padding + border → matches what users perceive as “card height”.
    const next = el.offsetHeight;

    // Avoid unnecessary state updates; reduces re-render churn.
    setTagsCardHeightPx((prev) => (prev === next ? prev : next));
  }

  /**
   * useLayoutEffect gives us a measurement ASAP after first render
   * (before the browser paints), reducing visible “jump”.
   */
  useLayoutEffect(() => {
    syncTagsHeightToImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Keep height in sync as layout changes.
   *
   * ResizeObserver reacts to real element size changes including:
   * - image load changing height
   * - responsive width changes
   * - font load shifts
   */
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

          {/* STEP CHANGE:
              Replace the redundant "status: indexed" pill with an Upload button.
              Keep the status pill for pending/failed, because those are meaningful states. */}
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

            {/* STEP OVERLAY CHANGE:
             Make the image container relative so absolutely-positioned buttons can anchor to it. */}
            <div className="relative mt-4 overflow-hidden rounded-2xl border border-gray-200">
              {/* Overlay actions live inside the same relative box */}
              {props.ImageActionsSlot}

              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={props.imageUrl}
                alt={`Pepe image ${props.imageId}`}
                className="h-auto w-full object-contain"
                // When the image finishes loading, its final height may differ.
                // We sync again immediately to avoid “tags card mismatch”.
                onLoad={() => syncTagsHeightToImage()}
              />
            </div>
          </div>

          {/* Tags card (always height-matched to image card) */}
          <aside
            className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
            // Force tags panel to match image panel height when we have a measurement.
            // During the very first paint, tagsCardHeightPx may be null; in that case
            // the card is natural height until we measure.
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
