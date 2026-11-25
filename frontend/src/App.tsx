import { lazy, Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { InstallBanner } from './components/InstallBanner';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { HomePage } from './pages/HomePage';
import { TermsPage } from './pages/TermsPage';
import { ReportPage } from './pages/ReportPage';

const AdminAuthPage = lazy(() =>
  import('./pages/AdminAuthPage').then((m) => ({ default: m.AdminAuthPage }))
);
const AdminResetPage = lazy(() =>
  import('./pages/AdminResetPage').then((m) => ({ default: m.AdminResetPage }))
);

export function App() {
  return (
    <HashRouter>
      <div className="min-h-screen flex flex-col">
        <InstallBanner />
        <Header />
        <div className="flex-1">
          <Suspense
            fallback={
              <div className="py-20 text-center text-sm text-slate-400">Loading...</div>
            }
          >
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/admin" element={<AdminAuthPage />} />
              <Route path="/admin/reset" element={<AdminResetPage />} />
            </Routes>
          </Suspense>
        </div>
        <Footer />
      </div>
    </HashRouter>
  );
}

export default App;
