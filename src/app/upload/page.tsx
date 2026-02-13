/**
 * "/upload" — Upload page (MVP1, 4th and final page in MVP)
 *
 * Responsibility (page-level):
 * - Provide a simple, professional shell for the upload UI.
 * - Keep this page a Server Component by default.
 *
 * Why Server Component wrapper?
 * - The page layout (title, framing) is static and doesn’t need client JS.
 * - The upload form itself *does* need client JS (file picker, hashing, progress),
 *   so we isolate that into a client component.
 *
 * Architecture:
 * - Client component performs:
 *   - client-side validation (UX)
 *   - SHA-256 hashing (Web Crypto)
 *   - tRPC mutation call
 *   - direct S3 upload via presigned PUT
 *   - polling status via tRPC query
 *
 * We keep business rules on the server:
 * - file size/type caps are re-validated in the tRPC mutation
 * - dedupe is enforced by DB uniqueness on sha256
 */

import Link from "next/link";
import { UploadForm } from "./_components/upload-form";

export default function UploadPage() {
  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-3xl px-6 py-10">
        {/* Local navigation keeps this page from feeling isolated. */}
        <div className="flex items-center justify-between">
          <div></div>

          <Link
            href="/"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Home
          </Link>
        </div>

        <h1 className="mt-4 ml-2 text-2xl font-semibold text-gray-900">
          Upload
        </h1>
        <p className="mt-6 ml-2 text-sm text-gray-600">
          Upload your own Pepe images to support the public corpus. Upon upload
          images have to await being pushed through a vision model, so they may
          not appear in search right away.
        </p>

        {/* Client-side uploader: isolated for correctness + minimal JS surface. */}
        <div className="mt-7">
          <UploadForm />
        </div>
      </div>
    </main>
  );
}
