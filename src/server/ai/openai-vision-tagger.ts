/**
 * OpenAI vision tagger adapter (worker-only).
 *
 * This module is an adapter:
 * - It talks to OpenAI over HTTP (Responses API).
 * - It returns parsed, validated, normalized tag suggestions.
 *
 * Architectural boundaries:
 * - This module does not touch the database.
 * - This module does not check caps/kill-switch.
 *   Those are enforced in the worker before calling into this adapter.
 *
 * Architecture:
 * - It keeps policy (cost safety / queueing) separate from integration (OpenAI API).
 * - It makes swapping providers later a single-module change.
 */

import { env } from "~/env";
import { tokenizeQuery } from "~/lib/text/normalize";

import { instruction } from "~/server/ai/taggingPrompt";

// Allowed tag kinds from the prompt.
export type TagKind =
  | "emotion"
  | "object"
  | "action"
  | "event"
  | "person"
  | "color"
  | "setting"
  | "style";

// A single tag predicted by the model.
export type ModelTag = {
  name: string; // Normalized tag name
  confidence: number; // 0..1 confidence
  kind: TagKind; // One of the allowed kinds (validated)
};

// The overall JSON structure the prompt requires.
export type ModelTaggingResult = {
  caption: string; // Human-readable description
  tags: ModelTag[]; // Tag list with confidence + kind
};

// Type guard for allowed tag kinds.
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

// Is a value a plain object (record)?
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Safe property read from an unknown record.
function getProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

// Extract the first assistant "output_text" block from the Responses API response.
function extractFirstOutputText(resp: unknown): string {
  if (!isRecord(resp)) {
    throw new Error("OpenAI response was not an object.");
  }

  const output = getProp(resp, "output");
  if (!Array.isArray(output)) {
    throw new Error("OpenAI response missing output array.");
  }

  for (const item of output) {
    if (!isRecord(item)) continue;

    const type = getProp(item, "type");
    const role = getProp(item, "role");

    // Responses API emits "message" objects that contain the assistant content.
    if (type !== "message") continue;
    if (role !== "assistant") continue;

    const content = getProp(item, "content");
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      // "output_text" carries the model's text output.
      if (!isRecord(part)) continue;

      const partType = getProp(part, "type");
      if (partType !== "output_text") continue;

      const text = getProp(part, "text");
      if (typeof text === "string") {
        return text;
      }
    }
  }

  throw new Error("OpenAI response contained no assistant output_text.");
}

/*
 * Parse the model JSON output into the typed ModelTaggingResult.
 *
 * Important:
 * - Do not force model tag names to be single tokens directly.
 * - Treat them as free-form phrases, then run tokenizeQuery(name).
 */
function parseModelJson(outputText: string): ModelTaggingResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(outputText);
  } catch {
    // Fail loudly: if JSON parsing fails, the prompt contract is broken.
    throw new Error(
      `OpenAI did not return valid JSON. Raw output: ${outputText}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`OpenAI JSON was not an object. Raw output: ${outputText}`);
  }

  const captionVal = getProp(parsed, "caption");
  const tagsVal = getProp(parsed, "tags");

  if (typeof captionVal !== "string") {
    throw new Error(
      `OpenAI JSON missing caption string. Raw output: ${outputText}`,
    );
  }

  if (!Array.isArray(tagsVal)) {
    throw new Error(
      `OpenAI JSON missing tags array. Raw output: ${outputText}`,
    );
  }

  const tokenTags: ModelTag[] = [];

  for (const item of tagsVal) {
    if (!isRecord(item)) continue;

    const nameVal = getProp(item, "name");
    const confidenceVal = getProp(item, "confidence");
    const kindVal = getProp(item, "kind");

    if (typeof nameVal !== "string") continue;
    if (typeof confidenceVal !== "number") continue;
    if (!isTagKind(kindVal)) continue;

    // Clamp confidence defensively.
    const clampedConfidence = Math.max(0, Math.min(1, confidenceVal));

    /**
     * Split the model name into normalized tokens.
     * This automatically:
     * - trims/collapses whitespace
     * - lowercases ASCII
     * - strips non-ASCII
     * - strips punctuation
     * - preserves inner hyphens
     * - removes stopwords (DEFAULT_STOPWORDS)
     * - dedupes within the phrase
     */
    const tokens = tokenizeQuery(nameVal);

    for (const tok of tokens) {
      tokenTags.push({
        name: tok,
        confidence: clampedConfidence,
        kind: kindVal,
      });
    }
  }

  // De-dupe by tag name, keep the highest confidence.
  const byName = new Map<string, ModelTag>();
  for (const t of tokenTags) {
    const prev = byName.get(t.name);
    if (!prev || t.confidence > prev.confidence) {
      byName.set(t.name, t);
    }
  }

  // Deterministic ordering for stability.
  const deduped = Array.from(byName.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // Secondary tie-break: name ascending for full determinism.
    return a.name.localeCompare(b.name);
  });

  return {
    caption: captionVal.trim(),
    tags: deduped,
  };
}

// Call OpenAI vision and return {caption, tags[]}.
export async function tagImageWithOpenAI(params: {
  imageUrl: string;
}): Promise<ModelTaggingResult> {
  // Enforce a strict per-call timeout to keep spend and worker latency bounded.
  // If the model is slow or the network stalls, fail-closed.
  const timeoutMs = env.OPENAI_VISION_TIMEOUT_MS;

  const signal = AbortSignal.timeout(timeoutMs);

  /**
   * OpenAI Responses API call:
   * Send it a “user message” whose content contains:
   * - input_text (the instructions)
   * - input_image (the URL)
   *
   * (OpenAI’s vision docs)
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

    // Temperature 0 pushes the model toward more deterministic outputs.
    temperature: 0,

    // Hard cap on output tokens.
    max_output_tokens: 3000,

    // Ask OpenAI to treat the text output as plain text.
    // Enforce JSON-ness here via the instruction + parsing.
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

  // If OpenAI returns an error (429, 401, 500, etc.), surface a trimmed error to the worker.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI Repsonses API error: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  /**
   * Responses API response shape:
   * The assistant output is in response.output[] items of type "message",
   * and the text content parts are type "output_text" with a .text field.
   */
  const json = (await res.json()) as unknown;
  const outputText = extractFirstOutputText(json);

  return parseModelJson(outputText);
}
