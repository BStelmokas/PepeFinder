# PepeFinder

PepeFinder is an AI-tagged **Pepe meme search engine** built as a small, production-minded system.

It is intentionally simple, intentionally bounded, and intentionally deterministic.

---

# Try It in 60 Seconds

1. Visit the homepage (`https://pepefinder.vercel.app/`)
2. Search: `sad pepe`
3. Search: `film noir`
4. Click any image → see caption + scrollable tags.
5. Download the image (attachment forced).
6. Flag it → watch the counter update.
7. Upload a new image → see image page with `pending → indexed` transition.

Search works regardless if the AI worker is running or paused.

---

# Key Technical Highlights

- **DB-only search path** (no model calls on requests)
- **Async worker** with `FOR UPDATE SKIP LOCKED`
- **Strict cost controls** (pause flag, daily caps, timeouts)
- **SHA-256 dedupe** across all ingestion modes
- **Deterministic ranking + cursor pagination**
- **Frozen normalization rules with tests**
- **Migration-based DB evolution**
- **Operator moderation workflow (CLI)**
- **Production polish (metadata, previews, robots)**

A boundary-focused system.

---

# Core Design Principle

> The request path is DB-only.
> All model calls happen in a background worker.
> Cost safety is architectural.

---

# Architecture Overview

## Web Layer (Next.js + tRPC)

- Server Components call server-side tRPC caller.
- No direct DB access from components.
- Route handlers used only for infra concerns (health, download streaming).

## Database (Postgres + Drizzle)

- Deterministic tag-overlap search.
- Keyset pagination.
- Migration-based schema control.

## Async Worker

Separate Node process:

1. Claims job using `FOR UPDATE SKIP LOCKED`
2. Enforces:
   - `TAGGING_PAUSED`
   - `TAGGING_DAILY_CAP`
   - strict model timeout
3. Calls vision model
4. Writes caption + normalized tags
5. Transitions image status

Worker runs outside Vercel (separate compute), safe to pause at any time.

---

# Search Semantics

Eligibility:
at least one distinct query token matches a tag.

Ranking:
match_count DESC
created_at DESC
id DESC

Confidence does not affect ranking.

Deterministic, no fuzzy search, no stemming, no synonyms.

---

# Searchability Improvements

Two invariants are enforced across ingestion:

### Stopword filtering

Removes:
`a`, `an`, `the`

Applies to:

- Queries
- Model tag phrases

Prevents noise tags.

---

### Hyphen expansion

`film-noir` → also `film` + `noir`
`red-shirt` → also `red` + `shirt`

Original tag preserved.

Improves recall without fuzzy logic.

---

# Pages

Core pages:

1. `/` — search
2. `/search?q=...` — results
3. `/image/[id]` — image detail
4. `/upload` — upload + polling

Production hygiene pages:

- `/privacy`
- `/takedown`

Global footer includes contact link.

---

# Ingestion Modes

## Manual Seed

Curated dataset.

## Upload

- Client + server validation
- SHA-256 dedupe
- Enqueues tag job

## Reddit / Pinterest Archive Batch

- Direct image URL ingestion only
- Idempotent
- Safe to re-run

No crawler infra, no background scrapers.

---

# Database Schema (Core Tables)

## images

- sha256 (unique)
- storage key
- status
- caption
- flag_count
- timestamps

## tags

- normalized dictionary
- unique name

## image_tags

- image_id
- tag_id
- confidence

## tag_jobs

- Postgres-backed queue
- unique per image

---

# Operational Features

## Download Endpoint

Forces attachment streaming.
Cross-browser reliable.

## Flag Toggle

Soft moderation signal.
No accounts required.

## Moderation Script

CLI-based:

- Unlist
- Delete
- Dry-run
- Threshold guard

---

# Database Migrations

Schema changes use:

pnpm db:generate
pnpm db:migrate

Migrations committed to Git.
Deploys deterministic.

---

# Local Development

Install:

```bash
pnpm install
```

Generate migrations:

```bash
pnpm db:generate
```

Apply migrations:

```bash
pnpm db:migrate
```

Run app:

```bash
pnpm dev
```

Run worker:

```bash
pnpm worker:tagger
```

---

# Operational Safety Controls

Environment variables:

```
TAGGING_PAUSED

TAGGING_DAILY_CAP

OPENAI_API_KEY

OPENAI_VISION_MODEL

OPENAI_VISION_TIMEOUT_MS
```

If paused or capped:

```
→ no model calls.
```

If model fails:

```
→ job fails safely.
```

Search remains unaffected.

---

# Why This Project Exists

PepeFinder demonstrates:

```
AI integration without request-path coupling

Deterministic ranking

Cursor-based pagination

Idempotent ingestion pipelines

Async job orchestration using Postgres

Operator-controlled moderation

Cost-aware design

Production hygiene and schema discipline

It is intentionally small —
but built like something that expects to grow.
```
