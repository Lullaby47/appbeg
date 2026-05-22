export default function FloatingCasinoBackdrop() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      aria-hidden
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(168,85,247,0.22),transparent),radial-gradient(ellipse_80%_50%_at_100%_50%,rgba(234,179,8,0.12),transparent),radial-gradient(ellipse_60%_40%_at_0%_80%,rgba(220,38,38,0.1),transparent)]" />
      <div
        className="absolute -left-10 top-[15%] text-4xl opacity-[0.12] sm:text-5xl"
        aria-hidden
      >
        🪙
      </div>
      <div
        className="absolute right-[5%] top-[25%] text-3xl opacity-[0.1] sm:text-4xl"
        aria-hidden
      >
        💎
      </div>
      <div
        className="absolute bottom-[20%] left-[20%] text-3xl opacity-[0.08]"
        aria-hidden
      >
        🎰
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_0%,rgba(0,0,0,0.4)_100%)]" />
    </div>
  );
}
