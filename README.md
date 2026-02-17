# PepeFinder

PepeFinder is an AI-tagged **Pepe meme search engine** designed as a small, production-minded system.

It is intentionally simple, intentionally bounded, and intentionally deterministic.

This repository is both:

1. A real deployable application.
2. My primary portfolio project — built to be readable, reasoned about, and maintainable.

---

# Core Design Principle

> The request path is DB-only.
> All model calls happen in a background worker.
> Cost safety is architectural.

---

# What the Product Does

## The Core Loop

1. Images enter the system (manual seed, upload, or batch ingestion).
2. A background worker generates:
   - a caption
   - structured tags with confidence
3. Caption tokens are normalized and inserted into the global tag dictionary.
4. Search matches query tokens against tags.
5. Results are ranked deterministically.
6. Pagination is keyset-based and stable.

Search never depends on AI availability.

---

# New: Download & Moderation

## Reliable Downloads

Images can be downloaded via a dedicated server endpoint that:

- Fetches the object from storage
- Streams bytes through the app layer
- Forces `Content-Disposition: attachment`

This guarantees consistent download behavior across browsers and object storage providers.

---

## Flag Toggle (Soft Moderation)

Each image includes a flag icon that:

- Toggles per browser
- Turns red when flagged
- Updates a persistent `flag_count` in the database
- Can be toggled off (decrementing the counter safely)

This is intentionally a **soft moderation signal**:

- No accounts
- No authentication
- No complex abuse controls
- No hidden background automation

Moderation is explicit and operator-driven.

---

## Operator Moderation Script

A CLI script allows:

- Unlisting images (removing from search by changing status)
- Deleting images (removing DB row + storage object)
- Dry-run preview mode
- Safety guard: minimum flag threshold must be ≥ 1

Moderation remains an operational workflow, not a UI feature.

---

# Search Characteristics

## Deterministic Ranking

Eligibility:
at least one distinct query token matches a tag.

Ranking:
match_count DESC
created_at DESC
id DESC

Confidence does not affect ranking.

---

## Caption-as-Tag Indexing

Captions are stored and rendered on the image page.

Caption tokens are normalized and inserted as tags during worker processing, so users can search by remembered phrases without changing ranking semantics.

---

## Stopwords + Hyphenated Tags (Searchability Improvements)

As the corpus grew (and model tagging became “real”), two practical issues showed up:

1. The model sometimes emitted stopwords as tags (e.g. `a`, `the`, `and`) — pure noise for tag overlap search.
2. Some useful tags were hyphenated (`film-noir`, `red-shirt`) but users naturally search with spaces (“film noir”, “red shirt”).

PepeFinder now enforces two invariants across **all** ingestion paths (uploads, seed scripts, Reddit batch runs, and the worker):

- **Stopword filtering**
  - Stopwords are removed at token boundaries using the shared normalization module.
  - This applies to user queries _and_ to model-produced tag phrases before persistence.
  - Default stopwords are intentionally tiny: `a`, `an`, `the`, `and`.

- **Hyphen expansion**
  - If an image has a hyphenated tag, it automatically receives the split tokens too:
    - `film-noir` → also `film` and `noir`
    - `red-shirt` → also `red` and `shirt`
  - The original hyphenated tag is preserved (it’s still useful and often the “best” label).
  - A one-off, idempotent backfill script brings already-tagged images up to the same invariant.

This keeps ranking deterministic while making search behave more like humans expect.

---

# Pagination

Search uses **cursor-based keyset pagination**.

Default page size: **96 results**.

Cursor tuple:

(match_count, created_at, id)

This ensures:

- Stable ordering
- No offset-scan performance degradation
- Deterministic next-page boundaries

---

# Stack

- Next.js (App Router)
- tRPC (authoritative app API)
- Drizzle ORM
- PostgreSQL
- Zod
- Tailwind CSS
- S3-compatible object storage (Cloudflare R2 compatible)
- OpenAI Vision model (worker-only integration)
- Node 20
- pnpm

---

# Architecture Overview

## Application Layer

- All domain logic lives behind tRPC procedures.
- Server Components call the server-side tRPC caller.
- No component directly queries the database.
- Route handlers are infra-only (health, download streaming).

---

## Storage Layer

- Images stored in S3-compatible bucket.
- SHA-256 dedupe.
- Deterministic storage keys.
- Idempotent ingestion.
- Attachment streaming endpoint for reliable downloads.

---

## Async Worker

Separate Node process:

1. Claims job using `FOR UPDATE SKIP LOCKED`
2. Enforces:
   - `TAGGING_PAUSED`
   - `TAGGING_DAILY_CAP`
   - strict model timeout
3. Calls vision model
4. Writes caption + tags
5. Transitions image status

Before writing tags, the worker also applies the shared normalization rules:

- stopword filtering (drops `a`, `an`, `the`, `and`)
- phrase tokenization into atomic tags
- hyphenated tag expansion (`film-noir` → `film` + `noir`)

If the model fails:

- Job marked failed
- Image marked failed
- Search unaffected

---

# Pages (MVP Scope)

Core product pages are **exactly four**:

1. `/` — search entry
2. `/search?q=...` — results grid
3. `/image/[id]` — image detail (caption + tags + download + flag)
4. `/upload` — upload + indexing polling

In addition, the app ships two **static production hygiene pages**:

- `/privacy` — minimal privacy policy (honest MVP statement)
- `/takedown` — clear removal process for rights-holders

A global footer links Contact / Privacy / Takedown on every page.

---

# Database Schema

## images

- storage pointer
- sha256 (unique)
- status (pending/indexed/failed)
- caption
- flag_count (soft moderation signal)
- optional attribution (source, source_ref, source_url)
- timestamps (UTC)

## tags

- normalized global tag dictionary
- unique name

## image_tags

- image_id
- tag_id
- confidence
- composite primary key

## tag_jobs

- Postgres-backed queue
- unique per image
- status + attempts + error storage

Search joins:

images → image_tags → tags

Ranking uses:

COUNT(DISTINCT tag_id)

---

# Ingestion Modes

## Manual Seed

Small curated dataset.

## Upload

- Validated on client + server
- SHA-256 dedupe
- Enqueues tagging job

## Reddit Archive Ingestion (Manual Batch)

- Processes archived JSON link sets (~6k+ processed)
- Filters direct image URLs
- Downloads, hashes, uploads
- Idempotent
- Enqueues tagging jobs

No crawler infra.
No background scraping daemon.

---

# Operational Pages (Contact / Privacy / Takedown)

Even small services need a clear “human backstop.”

PepeFinder includes:

- A global footer with:
  - Contact (mailto)
  - Privacy (`/privacy`)
  - Takedown (`/takedown`)
- A simple takedown process that’s handled manually by the operator

This isn’t over-engineering — it’s basic production hygiene, especially when hosting user uploads and third-party sourced images.

---

# New: Compact Image Detail Layout (Scrollable Tags)

As the corpus grew, the image detail page regularly showed 30+ tags per image.

Instead of letting the page become a long scroll:

- The tags panel is **height-matched to the image panel**
- If tags exceed the available space, the tags list becomes **internally scrollable**
- The image itself stays natural-size (never stretched)
- This behavior applies on **mobile and desktop**, including one-column layouts

This is a small UX polish that keeps browsing fast and keeps the UI feeling “tight” even with dense metadata.

---

# Database Migrations (Important)

This project is moving into a real production regime.

For prototyping, `drizzle-kit push` is convenient — but it can apply destructive diffs and it does **not** leave an auditable history.

PepeFinder now uses a migration-based workflow:

- **Generate** SQL migrations from schema changes:
  - `pnpm db:generate`
- **Apply** migrations to a target database:
  - `pnpm db:migrate`

Migration files live in `./drizzle/` and are committed to Git, so schema changes are reviewable and deploys are deterministic.

---

# Local Development

Install:

```bash
pnpm install
Generate migrations (recommended workflow):

pnpm db:generate
Apply migrations:

pnpm db:migrate
Run app:

pnpm dev
Run worker:

pnpm worker:tagger
Run moderation script:

pnpm flags:moderate -- --mode=unlist -- --min=5 --dry-run
Run stopword cleanup:

pnpm remove:stopwords
Run hyphen backfill:

pnpm hyphens:backfill
```

Note: pnpm drizzle-kit push still exists, but it is intentionally avoided for production-style workflows.

Operational Safety Controls
Worker-only environment variables:

TAGGING_PAUSED

TAGGING_DAILY_CAP

OPENAI_API_KEY

OPENAI_VISION_MODEL

OPENAI_VISION_TIMEOUT_MS

Fail-closed guarantees:

If paused or cap exceeded → no model calls.

If model errors or times out → job fails safely.

Search continues operating.

Why This Project Exists
PepeFinder demonstrates:

Controlled AI integration

Deterministic ranking

Cursor-based pagination

Clear API boundaries

Async job design using Postgres

Idempotent ingestion pipelines

Operator-controlled moderation

Cost-aware architecture

Production-minded DB migrations

It is intentionally small — but structured to grow without surprises.
