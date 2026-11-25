import { Clock, Lock, Zap } from 'lucide-react';

export function FeatureCards() {
  const cards = [
    {
      icon: Zap,
      title: 'Instant & Fast',
      desc: 'Upload and generate in seconds. Fast short-link redirects with zero waiting and no sign-up required.',
    },
    {
      icon: Lock,
      title: 'Secure Links',
      desc: 'Every file is verified by content signature and receives a private, unguessable short link.',
    },
    {
      icon: Clock,
      title: 'Long-Lasting',
      desc: 'Files stay available as long as storage space remains; oldest uploads rotate out cleanly when capacity fills.',
    },
  ];

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 mt-12">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {cards.map(({ icon: Icon, title, desc }) => (
          <div
            key={title}
            className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 text-center hover:shadow-md transition"
          >
            <div className="w-11 h-11 rounded-xl bg-amber-50 border border-amber-200/80 text-[#D9A441] flex items-center justify-center mx-auto mb-4">
              <Icon className="w-5 h-5" />
            </div>
            <h3 className="text-base font-bold text-[#0A1832] mb-2">{title}</h3>
            <p className="text-sm text-slate-500 leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
