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
          <p>Find your Pepe by describing the image.</p>
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
            className="mb-2 block text-xs font-medium text-gray-500"
          >
            Search tags
          </label>

          <div className="flex flex-col gap-3 sm:flex-row">
            {/* Search input: name="q" is the key detail for GET navigation. */}
            <input
              id="q"
              name="q"
              type="text"
              placeholder="e.g. ice cream red cap smiling beach..."
              className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 shadow-sm outline-none placeholder:text-gray-400 focus:border-gray-300"
              // Defaulting autoComplete off keeps weird browser suggestions from dominating the MVP UI.
              autoComplete="off"
            />

            {/* Submit button: minimal, neutral styling. */}
            <button
              type="submit"
              className="rounded-xl bg-gray-900 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-gray-800"
            >
              Search
            </button>
          </div>

          {/* Hint text: reinforces the frozen semantics gently. */}
          <p className="mt-3 text-xs text-gray-500">
            Object | Color | Action | Emotion | Setting | Event
          </p>
        </form>
      </div>
    </main>
  );
}
