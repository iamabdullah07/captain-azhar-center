import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/70 mt-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
        <div className="flex items-center gap-2.5">
          <img src="./logo.png" alt="Captain Azhar Center" className="h-6 w-auto" />
          <span className="font-bold text-[#0A1832] text-sm">Captain Azhar Center</span>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link to="/terms" className="hover:text-[#0A1832] font-medium transition">
            Terms &amp; Privacy
          </Link>
          <span className="text-slate-300">|</span>
          <Link to="/report" className="hover:text-[#0A1832] font-medium transition">
            Report Abuse
          </Link>
          <span className="text-slate-300">|</span>
          <span>&copy; {new Date().getFullYear()} Captain Azhar Center</span>
        </div>
      </div>
    </footer>
  );
}
