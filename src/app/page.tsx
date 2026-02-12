/**
 * "/" — Home page (MVP0)
 *
 * Responsibility:
 * - Provide the simplest possible entrypoint into the product:
 *   a centered search box that navigates to /search?q=...
 *
 * Architectural choices:
 * - This is a Server Component (default in App Router) because it does not need client state.
 * - We use a plain HTML <form> with method="GET" so:
 *   - the URL becomes the source of truth (shareable, bookmarkable)
 *   - the navigation is handled by the browser / Next.js naturally
 *   - no client-side JavaScript is required for MVP0
 *
 * UX goal:
 * - Minimal, fast, “Google-like” search entry.
 */

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white">
      {/* Center the content both vertically and horizontally for a clean MVP landing. */}
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6">
        {/* Product name as a simple, strong header. */}
        <h1 className="text-4xl font-semibold tracking-tight text-gray-900">
          PepeFinder
        </h1>
        {/* A small subtitle explains the value prop without adding UI complexity. */}
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

          {/* STEP CHANGE:
              Make layout responsive so it doesn't overflow on mobile.

              Mobile (default):
              - 2 rows using flex-col
              - Row 1: input + Search on one line
              - Row 2: Upload button below (aligned right)

              Desktop (sm+):
              - Switch back to the 2x2 grid:
                Row 1: [input] [Search]
                Row 2: [hints] [Upload]
           */}
          <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_auto] sm:grid-rows-2 sm:gap-x-3 sm:gap-y-1">
            {/* --- Mobile Row 1: input + Search --- */}
            <div className="flex flex-row items-start gap-3 sm:contents">
              {/* Search input: name="q" is the key detail for GET navigation. */}
              {/* Input:
                  STEP CHANGE: slightly reduce horizontal padding on mobile (px-3 instead of px-4)
                  so the row fits more comfortably on narrow screens.
                  On sm+ we keep the original padding. */}
              <input
                id="q"
                name="q"
                type="text"
                required
                placeholder="e.g. ice cream red cap smiling beach..."
                className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-3 text-sm text-gray-900 shadow-sm outline-none placeholder:text-gray-400 focus:border-gray-300 sm:px-4"
                // Defaulting autoComplete off keeps weird browser suggestions from dominating the MVP UI.
                autoComplete="off"
              />
              {/* Submit button: minimal, neutral styling. */}
              {/* Search button:
                  STEP CHANGE: slightly reduce padding on mobile so it fits in the box.
                  On sm+ it returns to the larger “desktop” padding. */}
              <button
                type="submit"
                className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50 sm:px-5"
              >
                Search
              </button>
            </div>

            {/* --- Desktop Row 2, Col 1: hints (hidden on mobile) --- */}
            {/* STEP CHANGE: hide on mobile to reduce clutter as requested. */}
            <p className="ml-1 hidden self-center text-xs text-gray-500 sm:block">
              Objects | Colors | Actions | Emotions | Settings | Events
            </p>

            {/* --- Upload button --- */}
            {/* Mobile:
                - placed as its own row under the input/search row
                - aligned to the right to feel “attached” to the action buttons
                Desktop:
                - sits in grid row 2 col 2 (next to hints) */}
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
