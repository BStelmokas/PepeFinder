/**
 * Root tRPC router composition point (T3 default).
 *
 * Why this file matters:
 * - It is the single authoritative place where we “assemble” the API.
 * - The AppRouter type exported from here is what gives end-to-end typing to:
 *   - `api.*` in React Client Components
 *   - server-side tRPC callers in Server Components
 *
 * If this file is wrong, TypeScript can’t infer procedure types,
 * and ESLint will correctly scream about unsafe `any/unknown` usage.
 */

import { createTRPCRouter, createCallerFactory } from "~/server/api/trpc"; // T3 router helpers + typed server caller factory.

import { searchRouter } from "~/server/api/routers/search";
import { imageRouter } from "~/server/api/routers/image";

import { uploadRouter } from "~/server/api/routers/upload";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  search: searchRouter,
  image: imageRouter,

  upload: uploadRouter,
});

// Export type definition of API (this is what gives `api.*` its types).
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
