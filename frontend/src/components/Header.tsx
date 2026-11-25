import { ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';

export function Header() {
  return (
    <header className="bg-white/90 backdrop-blur border-b border-slate-200/80 sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-3 group">
          <img
            src="./logo.png"
            alt="Captain Azhar Center Logo"
            className="h-9 w-auto object-contain transition-transform group-hover:scale-105"
          />
          <div className="leading-tight">
            <div className="text-base sm:text-lg font-extrabold tracking-tight text-[#0A1832]">
              Captain Azhar Center
            </div>
            <div className="text-[11px] font-bold tracking-wide text-[#D9A441]">
              QR Code Service
            </div>
          </div>
        </Link>

        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold shrink-0">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>Secure &amp; Private</span>
        </div>
      </div>
    </header>
  );
}
