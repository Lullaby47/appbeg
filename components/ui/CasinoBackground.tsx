'use client';

type CasinoBackgroundVariant = 'player' | 'worker';

type CasinoBackgroundProps = {
  variant?: CasinoBackgroundVariant;
};

const PLAYER_ICONS = [
  { icon: '$', className: 'casino-icon-float casino-icon-player-a left-[8%] top-[16%]' },
  { icon: '777', className: 'casino-icon-float casino-icon-player-b right-[10%] top-[24%]' },
  { icon: 'GEM', className: 'casino-icon-float casino-icon-player-c left-[14%] bottom-[18%]' },
  { icon: 'COIN', className: 'casino-icon-float casino-icon-player-d right-[14%] bottom-[14%]' },
];

const WORKER_ICONS = [
  { icon: '$', className: 'casino-icon-float casino-icon-worker-a left-[7%] top-[18%]' },
  { icon: '777', className: 'casino-icon-float casino-icon-worker-b right-[12%] top-[28%]' },
  { icon: 'GEM', className: 'casino-icon-float casino-icon-worker-c left-[18%] bottom-[16%]' },
  { icon: 'COIN', className: 'casino-icon-float casino-icon-worker-d right-[16%] bottom-[12%]' },
];

export default function CasinoBackground({
  variant = 'worker',
}: CasinoBackgroundProps) {
  const isPlayer = variant === 'player';
  const icons = isPlayer ? PLAYER_ICONS : WORKER_ICONS;

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 -z-10 overflow-hidden ${
        isPlayer ? 'casino-bg-player' : 'casino-bg-worker'
      }`}
    >
      <div className="absolute inset-0 casino-bg-base" />
      <div className="absolute inset-0 casino-bg-grid opacity-[0.08]" />

      <div className="casino-ambient casino-ambient-one" />
      <div className="casino-ambient casino-ambient-two" />
      <div className="casino-ambient casino-ambient-three" />

      <div className="casino-glow-orb casino-glow-primary" />
      <div className="casino-glow-orb casino-glow-secondary" />
      <div className="casino-glow-orb casino-glow-accent" />

      <div className="casino-streak casino-streak-one" />
      <div className="casino-streak casino-streak-two" />
      <div className="casino-streak casino-streak-three hidden sm:block" />

      <div className="casino-guide casino-guide-lobby" />
      <div className="casino-guide casino-guide-bonus" />
      <div className="casino-guide casino-guide-play" />

      {isPlayer ? (
        <>
          <div className="casino-fire-ribbon casino-fire-ribbon-left" />
          <div className="casino-fire-ribbon casino-fire-ribbon-center" />
          <div className="casino-fire-ribbon casino-fire-ribbon-right" />

          <div className="casino-ember casino-ember-a" />
          <div className="casino-ember casino-ember-b" />
          <div className="casino-ember casino-ember-c" />
          <div className="casino-ember casino-ember-d" />
          <div className="casino-ember casino-ember-e" />
        </>
      ) : null}

      {icons.map((item) => (
        <div key={`${variant}-${item.icon}-${item.className}`} className={item.className}>
          <span>{item.icon}</span>
        </div>
      ))}

      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent_22%,transparent_72%,rgba(0,0,0,0.16))]" />
    </div>
  );
}
