/**
 * Root tRPC router composition point (T3 default).
 */

import { createTRPCRouter, createCallerFactory } from "~/server/api/trpc";

import { searchRouter } from "~/server/api/routers/search";
import { imageRouter } from "~/server/api/routers/image";

import { uploadRouter } from "~/server/api/routers/upload";

/**
 * This is the primary router for the server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  search: searchRouter,
  image: imageRouter,

  upload: uploadRouter,
});

export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
