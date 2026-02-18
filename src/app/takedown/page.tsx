/**
 * /takedown
 *
 * Minimal takedown policy page.
 *
 * Why this exists:
 * - The app stores third-party content (e.g. Reddit, Pinterest sourced images).
 * - There needs to be a clear, fast way for rights holders to request removal.
 */

import Link from "next/link";

const TAKEDOWN_EMAIL = "herodotus9719@gmail.com";

export default function TakedownPage() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex justify-end">
        <Link
          href="/"
          className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
        >
          ← Home
        </Link>
      </div>

      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Takedown Requests</h1>

        <p className="mt-3 text-sm text-gray-700">
          If you believe an image in PepeFinder infringes your rights, we will
          remove it.
        </p>

        <h2 className="mt-6 text-sm font-semibold text-gray-900">
          How to request removal
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          Email{" "}
          <a
            href={`mailto:${TAKEDOWN_EMAIL}`}
            className="text-gray-900 underline"
          >
            {TAKEDOWN_EMAIL}
          </a>{" "}
          with:
        </p>

        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-gray-700">
          <li>The PepeFinder image URL (preferred) or image ID.</li>
          <li>
            If applicable, the original source URL (e.g., Reddit post or direct
            image link).
          </li>
          <li>Your name and a short explanation of your claim.</li>
        </ul>

        <h2 className="mt-6 text-sm font-semibold text-gray-900">
          What happens next
        </h2>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-gray-700">
          <li>
            We verify the request and remove the content from our database and
            storage.
          </li>
          <li>
            We aim to respond within{" "}
            <span className="font-medium">48 hours</span>.
          </li>
        </ul>

        <p className="mt-6 text-xs text-gray-500">
          Last updated: {new Date().toLocaleDateString()}
        </p>
      </div>
    </main>
  );
}
