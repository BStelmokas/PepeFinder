"use client";

/**
 * ImageActions (Client Component)
 *
 * Why this is a Client Component:
 * - Clicking “Flag” must call a tRPC mutation (client-side interaction).
 * - Download could be server-rendered, but we keep both actions together for a clean UI block.
 *
 * Design choice:
 * - This component is “UI + interaction” only.
 * - All domain mutations still go through tRPC (authoritative API).
 *
 *
 *
 * Goal:
 * - Download button (simple UX)
 * - Flag button that:
 *   - increments DB flag_count ONCE per browser (best-effort, no auth)
 *   - turns red after click
 *   - persists “I flagged this” via localStorage
 *
 * Why localStorage:
 * - No auth, so the server cannot reliably know "this user already flagged".
 * - localStorage gives a lightweight, per-device memory:
 *   - good UX (button stays red after refresh)
 *   - reduces accidental double-flagging
 *
 * Important caveat:
 * - This is not a security boundary.
 * - A malicious user can clear storage / script requests.
 * - That's OK for MVP: flags are a soft moderation signal.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";

export function ImageActions(props: { imageId: number }) {
  /**
   * STEP FLAG UI CHANGE:
   * Track whether *this browser* has flagged this image.
   *
   * Why boolean state:
   * - We don't want to show a count.
   * - We only need to render "flagged (red)" vs "not flagged".
   */
  const [isFlagged, setIsFlagged] = useState<boolean>(false);

  /**
   * Storage key is deterministic per image id.
   * This keeps localStorage tidy and makes debugging easy.
   */
  const flagStorageKey = useMemo(() => {
    return `pepefinder:flagged:image:${props.imageId}`;
  }, [props.imageId]);

  /**
   * On mount, load previous flag state from localStorage.
   *
   * Why in useEffect:
   * - localStorage only exists in the browser.
   * - This is a Client Component, but still renders initially;
   *   useEffect avoids any server/client mismatch issues.
   */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(flagStorageKey);
      setIsFlagged(raw === "true");
    } catch {
      // If localStorage is blocked (privacy mode), we just won't persist.
      setIsFlagged(false);
    }
  }, [flagStorageKey]);

  const setFlagMutation = api.image.setFlag.useMutation({
    onSuccess: (_data, variables) => {
      // After server confirms, persist desired state locally.
      setIsFlagged(variables.flagged);

      try {
        if (variables.flagged) {
          localStorage.setItem(flagStorageKey, "true");
        } else {
          localStorage.removeItem(flagStorageKey);
        }
      } catch {
        // If storage fails, UI still turns red for this session.
      }
    },
  });

  // Toggle handler.
  function onToggleFlag() {
    // Toggle handler.
    const next = !isFlagged;

    // Send desired state to server so server can apply +1 / -1.
    setFlagMutation.mutate({ id: props.imageId, flagged: next });
  }

  return (
    <>
      {/* STEP OVERLAY CHANGE:
          Flag overlay (top-left).
          - Uses absolute positioning.
          - Uses translucent background so it’s readable on any image. */}

      {/* Flag icon button:
          - gray when not flagged
          - red when flagged
          - toggleable
          - disabled while mutation in flight to avoid racey double-clicks */}
      <button
        type="button"
        onClick={onToggleFlag}
        disabled={setFlagMutation.isPending}
        className={[
          "absolute top-3 left-3 z-10",
          "rounded-xl p-2",
          "bg-black/20 backdrop-blur-md",
          "transition hover:bg-black/40",
          setFlagMutation.isPending ? "cursor-not-allowed opacity-70" : "",
        ].join(" ")}
        aria-label={isFlagged ? "Unflag image" : "Flag image"}
        title={isFlagged ? "Unflag" : "Flag as problematic"}
      >
        {/* Inline SVG flag so we add zero deps.
            Color changes by state. */}
        <svg
          xmlns="http:/www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          className={[
            "h-5 w-5 transition-colors",
            isFlagged ? "text-red-500" : "text-white",
          ].join(" ")}
          fill="currentColor"
        >
          <path d="M6 3a1 1 0 0 1 1 1v1.2c2.1-1.2 4.3-1.3 6.6-.3 2.2.9 3.9.8 5.4.1a1 1 0 0 1 1.4.9v9.2a1 1 0 0 1-.6.9c-2.1.9-4.3 1-6.6.1-2.2-.9-3.9-.8-5.4-.1V21a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zm1 4.3v7.5c2.1-1.1 4.3-1.1 6.6-.1 1.7.7 3.1.8 4.4.4V8.3c-2.1.8-4.3.7-6.6-.2-1.7-.7-3.1-.8-4.4-.6z" />
        </svg>
      </button>

      {/* Download button */}
      {/* We hit our own infra route so we can force Content-Disposition: attachment.
        This is the reliable fix for “opens in new tab”. */}
      <a
        href={`/api/images/${props.imageId}/download`}
        className={[
          "absolute right-3 bottom-3 z-10",
          "rounded-xl px-3 py-2 text-sm font-medium",
          "bg-black/20 backdrop-blur-md",
          "text-white",
          "transition hover:bg-black/40",
        ].join(" ")}
      >
        Download
      </a>
    </>
  );
}
