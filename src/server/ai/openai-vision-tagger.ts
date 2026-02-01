/**
 * OpenAI vision tagger adapter (worker-only).
 *
 * This module is an *adapter*:
 * - It talks to OpenAI over HTTP (Responses API).
 * - It returns parsed, validated, normalized tag suggestions.
 *
 * Architectural boundaries:
 * - This module does NOT touch the database.
 * - This module does NOT check caps/kill-switch.
 *   Those are enforced in the worker *before* calling into this adapter.
 *
 * Why this is important:
 * - It keeps “policy” (cost safety / queueing) separate from “integration” (OpenAI API).
 * - It makes swapping providers later a single-module change.
 */

import { env } from "~/env"; // Centralized env access; never read process.env outside env.ts.
import { normalizeTagName } from "~/lib/text/normalize"; // Our frozen normalization logic (single source of truth).
import { instruction } from "~/server/ai/taggingPrompt";

/**
 * Allowed tag kinds from your prompt.
 *
 * We keep this as a union so TypeScript helps us maintain the contract.
 * If you later expand the taxonomy, you do it here in one place.
 */
export type TagKind =
  | "emotion"
  | "object"
  | "action"
  | "event"
  | "person"
  | "color"
  | "setting"
  | "style";

/**
 * A single tag predicted by the model.
 * We keep this shape small and explicit so swapping providers later is easy.
 * We validate/normalize before returning anything to the worker.
 */
export type ModelTag = {
  name: string; // Normalized tag name (lowercase ASCII etc.)
  confidence: number; // 0..1 confidence; shown in UI but NOT used for ranking (frozen rule).
  kind: TagKind; // One of the allowed kinds (validated)
};

/**
 * The overall JSON structure your new prompt requires.
 */
export type ModelTaggingResult = {
  caption: string; // Human-readable description (not used for ranking; not persisted yet)
  tags: ModelTag[]; // Tag list with confidence + kind
};

/**
 * Minimal helper: type guard for allowed tag kinds.
 *
 * Why not Zod here?
 * - This is a narrow worker-only adapter.
 * - We already enforce correctness with very defensive runtime checks + defaults.
 * - Keeping deps minimal is part of the spec.
 */
function isTagKind(v: unknown): v is TagKind {
  return (
    v === "emotion" ||
    v === "object" ||
    v === "action" ||
    v === "event" ||
    v === "person" ||
    v === "color" ||
    v === "setting" ||
    v === "style"
  );
}

/**
 * Extract the first assistant "output_text" block from the Responses API response.
 *
 * Why isolate this:
 * - OpenAI response shapes evolve; we want that churn in one place.
 * - The rest of the code should only care about the final string output.
 */
function extractFirstOutputText(resp: unknown): string {
  if (typeof resp !== "object" || resp === null) {
    throw new Error("OpenAI response was not an object.");
  }

  const output = (resp as any).output;
  if (!Array.isArray(output)) {
    throw new Error("OpenAI response missing output array.");
  }

  for (const item of output) {
    // Responses API emits "message" objects that contain the assistant content.
    if (item?.type !== "message") continue;
    if (item?.role !== "assistant") continue;

    const content = item?.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      // "output_text" carries the model's text output.
      if (part?.type === "output_text" && typeof part?.text === "string") {
        return part.text;
      }
    }
  }

  throw new Error("OpenAI response contained no assistant output_text.");
}

/**
 * Call OpenAI vision and return {caption, tags[]} according to your new prompt.
 *
 * This function:
 * - enforces hard timeout per call (fail-closed)
 * - enforces strict JSON parsing
 * - normalizes tags using frozen normalizeTagName()
 * - de-dupes by tag name, keeping the highest confidence
 * - clamps confidence to [0, 1]
 *
 * What it deliberately does NOT do:
 * - no DB writes
 * - no queue logic
 * - no cap/kill-switch checks
 */
export async function tagImageWithOpenAI(params: {
  imageUrl: string; // Must be a fully-qualified URL; can be public or pre-signed.
}): Promise<ModelTaggingResult> {
  // We enforce a strict per-call timeout to keep spend and worker latency bounded.
  // If the model is slow or the network stalls, we fail-closed.
  const timeoutMs = env.OPENAI_VISION_TIMEOUT_MS;

  // AbortSignal.timeout() is available in Node 20; it produces an AbortSignal that aborts after N ms.
  // This is our “hard stop” guarantee.
  const signal = AbortSignal.timeout(timeoutMs);

  /**
   * OpenAI Responses API call:
   * We send a “user message” whose content contains:
   * - input_text (our instructions)
   * - input_image (the URL)
   *
   * This is straight from OpenAI’s vision docs.
   */
  const body = {
    model: env.OPENAI_VISION_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: instruction },
          { type: "input_image", image_url: params.imageUrl },
        ],
      },
    ],

    // Temperature 0 pushes the model toward more deterministic outputs (fewer “creative” tags).
    temperature: 0,

    // Hard cap on output tokens: we only want a small JSON array.
    max_output_tokens: 900,

    // Ask OpenAI to treat the text output as plain text.
    // We enforce JSON-ness ourselves via the instruction + parsing.
    text: { format: { type: "text" } },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Standard Bearer auth for OpenAI.
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal, // The strict timeout enforcement.
  });

  // If OpenAI returns an error (429, 401, 500, etc.), we surface a trimmed error to the worker.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI Repsonses API error: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  /**
   * Responses API response shape (important for parsing):
   * The assistant output is in response.output[] items of type "message",
   * and the text content parts are type "output_text" with a .text field.
   */
  const json = (await res.json()) as unknown;
  const outputText = extractFirstOutputText(json);

  // The model *should* return strict JSON, but we still guard parsing.
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (e) {
    throw new Error(
      `OpenAI did not return valid JSON. Raw output: ${outputText}`,
    );
  }

  // Validate top-level shape: { caption: string, tags: array }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`OpenAI JSON was not an object. Raw output: ${outputText}`);
  }

  const caption = (parsed as any).caption;
  const rawTags = (parsed as any).tags;

  if (typeof caption !== "string") {
    throw new Error(
      `OpenAI JSON missing caption string. Raw output: ${outputText}`,
    );
  }

  if (!Array.isArray(rawTags)) {
    throw new Error(
      `OpenAI JSON missing tags array. Raw output: ${outputText}`,
    );
  }

  /**
   * Convert raw tags → normalized ModelTag[].
   *
   * We are intentionally defensive:
   * - We skip invalid items rather than failing the whole job.
   * - We clamp confidence.
   * - We normalize names via frozen rules.
   * - We validate kind is within the allowed union.
   *
   * The worker already treats model failures as “job failed”,
   * but within a successful response we still prefer partial salvage.
   */
  const cleaned: ModelTag[] = [];

  // Convert into our normalized, bounded ModelTag format.
  for (const item of rawTags) {
    if (typeof item !== "object" || item === null) continue;

    const name = (item as any).name;
    const confidence = (item as any).confidence;
    const kind = (item as any).kind;

    if (typeof name !== "string") continue;
    if (typeof confidence !== "number") continue;
    if (!isTagKind(kind)) continue;

    // Clamp confidence to [0, 1] so UI and DB stay sane even if model goes weird.
    const clamped = Math.max(0, Math.min(1, confidence));

    // Normalize tag names using frozen semantics.
    const normalized = normalizeTagName(name);

    // If normalization collapses to empty, skip.
    if (!normalized) continue;

    cleaned.push({ name: normalized, confidence: clamped, kind });
  }

  // De-dupe by name, keep highest confidence if duplicates exist.
  const byName = new Map<string, ModelTag>();
  for (const t of cleaned) {
    const prev = byName.get(t.name);
    if (!prev || t.confidence > prev.confidence) {
      byName.set(t.name, t);
    }
  }

  // Deterministic ordering for stable display/debugging.
  const deduped = Array.from(byName.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // Secondary tie-break: name ascending for full determinism.
    return a.name.localeCompare(b.name);
  });

  return {
    caption: caption.trim(),
    tags: deduped,
  };
}
