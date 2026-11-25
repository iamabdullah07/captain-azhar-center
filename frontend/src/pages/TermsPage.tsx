import { Link } from 'react-router-dom';
import { ArrowLeft, Shield } from 'lucide-react';

export function TermsPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-[#0A1832] mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to QR Generator
      </Link>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-[#D9A441]">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-[#0A1832]">Terms &amp; Privacy Notice</h1>
            <p className="text-xs text-slate-500">Captain Azhar Center — QR Code Service</p>
          </div>
        </div>

        <section className="space-y-2 text-sm text-slate-600 leading-relaxed">
          <h2 className="text-base font-bold text-[#0A1832]">1. Public Short Links</h2>
          <p>
            Every file or link receives a cryptographically random short ID. Anyone who has the short
            link or scans the QR code can access the file. Never upload confidential, sensitive, or
            legally restricted material.
          </p>
        </section>

        <section className="space-y-2 text-sm text-slate-600 leading-relaxed">
          <h2 className="text-base font-bold text-[#0A1832]">2. Storage Retention &amp; Auto-Cleanup</h2>
          <p>
            Files are kept as long as storage space is available. When free storage reaches capacity
            (80% of 10 GB), the oldest uploaded files are removed automatically first (regardless of
            file type) until storage returns to a safe level (70%). Link-only QR codes do not consume
            file storage.
          </p>
        </section>

        <section className="space-y-2 text-sm text-slate-600 leading-relaxed">
          <h2 className="text-base font-bold text-[#0A1832]">3. Prohibited Content &amp; Abuse</h2>
          <p>
            Uploading malware, phishing links, executable scripts, copyrighted material without rights,
            or illegal content is strictly prohibited. The administrator may block or remove any
            reported item at any time.
          </p>
        </section>
      </div>
    </main>
  );
}
