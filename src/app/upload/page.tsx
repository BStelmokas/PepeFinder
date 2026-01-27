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
          <Link href="/" className="text-sm text-gray-700 hover:text-gray-900">
            ← Home
          </Link>

          <Link
            href="/search/q=apustaja"
            className="text-sm text-gray-700 hover:text-gray-900"
          >
            Browse
          </Link>
        </div>

        <h1 className="mt-6 text-2xl font-semibold text-gray-900">Upload</h1>
        <p className="mt-2 text-sm text-gray-600">
          Upload an image. We store it immediately, then a background worker
          will tag it. Search remains DB-only and model calls never happen on
          the request path.
        </p>

        {/* Client-side uploader: isolated for correctness + minimal JS surface. */}
        <div className="mt-8">
          <UploadForm />
        </div>
      </div>
    </main>
  );
}
