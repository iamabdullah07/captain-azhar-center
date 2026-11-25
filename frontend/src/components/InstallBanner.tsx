import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'cac_install_banner_dismissed';

export function InstallBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (isStandalone) {
      setDismissed(true);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (dismissed) return null;

  const handleInstall = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice;
      if (res.outcome === 'accepted') {
        setDismissed(true);
      }
      setDeferredPrompt(null);
      return;
    }
    setShowHint((prev) => !prev);
  };

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore storage failure
    }
  };

  return (
    <div className="bg-[#0A1832] text-white border-b border-white/10">
      <div className="max-w-6xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
        <div className="flex items-center gap-2 text-slate-200">
          <Download className="w-4 h-4 text-[#D9A441] shrink-0" />
          <span>Install the Captain Azhar Center app for quick access.</span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={handleInstall}
            className="bg-[#D9A441] hover:bg-[#c89332] text-[#0A1832] font-bold px-3.5 py-1.5 rounded-lg text-xs transition cursor-pointer"
          >
            Install App
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss install banner"
            className="p-1 text-slate-400 hover:text-white rounded transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      {showHint && (
        <div className="bg-[#112446] text-slate-200 text-xs px-4 py-2 text-center border-t border-white/10">
          In Chrome/Edge use the browser menu &rarr; <strong>Install App</strong>; on iPhone Safari tap <strong>Share &rarr; Add to Home Screen</strong>.
        </div>
      )}
    </div>
  );
}
