# Create T3 App

This is a [T3 Stack](https://create.t3.gg/) project bootstrapped with `create-t3-app`.

## What's next? How do I make an app with this?

We try to keep this project as simple as possible, so you can start with just the scaffolding we set up for you, and add additional things later when they become necessary.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Prisma](https://prisma.io)
- [Drizzle](https://orm.drizzle.team)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!

## How do I deploy this?

Follow our deployment guides for [Vercel](https://create.t3.gg/en/deployment/vercel), [Netlify](https://create.t3.gg/en/deployment/netlify) and [Docker](https://create.t3.gg/en/deployment/docker) for more information.

---

Database Table Structures:

images table:

```
┌─────────────────────────────────────────┐
│ images                                  │
├─────────────────────────────────────────┤
│ id           SERIAL PRIMARY KEY         │
│ storage_key  TEXT        NOT NULL       │
│ sha256       VARCHAR(64) NOT NULL UNIQUE│
│ status       ENUM(image_status)         │
│ created_at   TIMESTAMPTZ NOT NULL       │
│ updated_at   TIMESTAMPTZ NOT NULL       │
│ source       VARCHAR(32)     NULL       │
│ source_ref   TEXT            NULL       │
└─────────────────────────────────────────┘

```

tags table

```
┌─────────────────────────────────────────┐
│ tags                                    │
├─────────────────────────────────────────┤
│ id           SERIAL PRIMARY KEY         │
│ name         VARCHAR(64) NOT NULL UNIQUE│
│ created_at   TIMESTAMPTZ NOT NULL       │
└─────────────────────────────────────────┘

```

image_tags table (join table)

```
┌─────────────────────────────────────────┐
│ image_tags                              │
├─────────────────────────────────────────┤
│ image_id     INT NOT NULL ──────────┐  │
│ tag_id       INT NOT NULL ───────┐  │  │
│ confidence   REAL NOT NULL       │  │  │
│ created_at   TIMESTAMPTZ NOT NULL│  │  │
├──────────────────────────────────┴──┴──┤
│ PRIMARY KEY (image_id, tag_id)          │
│ CHECK (confidence >= 0 AND <= 1)        │
└─────────────────────────────────────────┘

```

Whole-system relationship diagram

```
            ┌───────────────┐
            │   images      │
            │───────────────│
            │ id (PK)       │
            │ storage_key   │
            │ sha256        │
            │ status        │
            │ created_at    │
            └───────┬───────┘
                    │
                    │ 1
                    │
                    │ *
            ┌───────▼────────┐
            │  image_tags    │
            │────────────────│
            │ image_id (PK)  │
            │ tag_id   (PK)  │
            │ confidence     │
            │ created_at     │
            └───────┬────────┘
                    │
                    │ *
                    │
                    │ 1
            ┌───────▼───────┐
            │     tags      │
            │───────────────│
            │ id (PK)       │
            │ name (unique) │
            │ created_at    │
            └───────────────┘


```

Images and tags are global entities; meaning lives in the join table, and search is counting how many joins match a query.
