/**
 * "/" — Home page (MVP0)
 *
 * Responsibility:
 * - Provide the simplest possible entrypoint into the product:
 *   a centered search box that navigates to /search?q=...
 *
 * Architectural choices:
 * - This is a Server Component (default in App Router) because it does not need client state.
 * - Use a plain HTML <form> with method="GET" so:
 *   - the URL becomes the source of truth (shareable, bookmarkable)
 *   - the navigation is handled by the browser / Next.js naturally
 */

import type { Metadata } from "next";
import { env } from "~/env";

// Static metadata for SEO
export const metadata: Metadata = {
  title: "PepeFinder",
  description:
    "Search thousands of Pepe memes using deterministic tag-overlap ranking. Upload images and get AI-generated tags.",
  alternates: {
    canonical: new URL("/", env.SITE_URL),
  },
};

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6">
        {/* The logo is commented out as a styling decision but left as a future option */}
        {/* <img
          src="/brand/pepe-logo.png"
          alt="PepeFinder logo"
          className="mb-4 h-60 w-60 drop-shadow-sm select-none"
          draggable={false}
        /> */}

        {/* Product name */}
        <h1 className="text-4xl font-semibold tracking-tight text-gray-900">
          PepeFinder
        </h1>
        {/* Subtitle explaining the value proposition. */}
        <div className="mt-3 space-y-1 text-center text-sm text-gray-600">
          <p>No more googling in despair.</p>
          <p>Find your Pepe by describing the image itself.</p>
        </div>
        {/* GET form -> /search?q=... (URL is the contract). */}
        <form
          action="/search"
          method="GET"
          className="mt-8 w-full rounded-2xl border-gray-200 bg-white p-4 shadow-sm"
        >
          {/* Label is visually subtle but improves accessibility. */}
          <label
            htmlFor="q"
            className="mb-2 ml-1 block text-xs font-medium text-gray-500"
          >
            Search tags
          </label>

          <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_auto] sm:grid-rows-2 sm:gap-x-3 sm:gap-y-1">
            {/* --- Mobile Row 1: input + Search --- */}
            <div className="flex flex-row items-start gap-3 sm:contents">
              {/* Search input: name="q" is the key detail for GET navigation. */}
              <input
                id="q"
                name="q"
                type="text"
                required
                placeholder="e.g. cowboy hat..."
                className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-3 text-sm text-gray-900 shadow-sm outline-none placeholder:text-gray-400 focus:border-gray-300 sm:px-4"
                // Defaulting autoComplete off keeps weird browser suggestions from dominating the UI.
                autoComplete="off"
              />
              {/* Search button */}
              <button
                type="submit"
                className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50 sm:px-5"
              >
                Search
              </button>
            </div>

            {/* --- Desktop Row 2, Col 1: hints (hidden on mobile) --- */}
            <p className="ml-1 hidden self-center text-xs text-gray-500 sm:block">
              Objects | Colors | Actions | Emotions | Event | Setting
            </p>

            {/* --- Upload button --- */}
            <div className="flex justify-end sm:contents">
              <a
                href="/upload"
                className="rounded-xl bg-gray-900 px-4 py-1.5 text-center text-sm font-medium text-white shadow-sm hover:bg-gray-800 sm:self-center sm:px-5"
              >
                Upload
              </a>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
