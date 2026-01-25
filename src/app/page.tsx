/**
 * Temporary home page placeholder.
 *
 * Why we simplify this now:
 * - The generated T3 template often includes demo tRPC calls (hello/getLatest/etc).
 * - While we're building PepeFinder, that demo content is a distraction and can
 *   cause lint noise during refactors.
 *
 * We will replace this in MVP0 UI step with:
 * - "/" (home search)
 * - "/search?q=..."
 * - "/image/[id]"
 */

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-3xl font-bold">PepeFinder</h1>

      <p className="text-muted-foreground mt-4 text-sm">
        MVP0 scaffold is healthy. Next step is wiring the search UI to the tRPC
        procedures:
        <code className="bg-muted ml-2 rounded px-2 py-1">
          search.searchImages
        </code>{" "}
        and <code className="bg-muted rounded px-2 py-1">image.getById</code>.
      </p>
    </main>
  );
}
