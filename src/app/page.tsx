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
              Convert the layout into a 2x2 grid so the “hint line” sits to the LEFT of Upload,
              just like the input sits to the LEFT of Search.

              Layout:
                Row 1: [ input ]  [ Search ]
                Row 2: [ hints ]  [ Upload ]

              Why this fixes the “dragging” feeling:
              - The hints no longer occupy a full-width block under everything.
              - They share a row with Upload, keeping the card compact and visually balanced. */}
          <div className="grid-rows grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            {/* Search input: name="q" is the key detail for GET navigation. */}
            {/* Row 1, Col 1: input */}
            <input
              id="q"
              name="q"
              type="text"
              required
              placeholder="e.g. ice cream red cap smiling beach..."
              className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 shadow-sm outline-none placeholder:text-gray-400 focus:border-gray-300"
              // Defaulting autoComplete off keeps weird browser suggestions from dominating the MVP UI.
              autoComplete="off"
            />

            {/* Submit button: minimal, neutral styling. */}
            {/* Row 1, Col 2: Search button */}
            <button
              type="submit"
              className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
            >
              Search
            </button>

            {/* Row 2, Col 1: hint text (now aligned with Upload) */}
            {/* STEP CHANGE: center vertically to match the Upload button row */}
            {/* Hint text: reinforces the frozen semantics gently. */}
            <p className="ml-1 self-center text-xs text-gray-500">
              Objects | Colors | Actions | Emotions | Settings | Events
            </p>

            {/* Upload button: navigation, half-height.
                  STEP CHANGE:
                  - smaller vertical padding (py-1.5) gives “half height” feel
                  - still full width of the button column
                  - border style to keep it secondary */}
            {/* Row 2, Col 2: Upload button (half-height feel) */}
            <a
              href="/upload"
              className="self-center rounded-xl bg-gray-900 px-5 py-1.5 text-center text-sm font-medium text-white shadow-sm hover:bg-gray-800"
            >
              Upload
            </a>
          </div>
        </form>
      </div>
    </main>
  );
}
