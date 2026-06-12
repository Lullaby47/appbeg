'use client';

type InstallAppButtonProps = {
  canShowInstallButton: boolean;
  label?: string;
  onInstallClick: () => void;
  className?: string;
};

export default function InstallAppButton({
  canShowInstallButton,
  label = 'Install App',
  onInstallClick,
  className = 'w-full rounded-2xl border border-amber-400/35 bg-amber-500/10 py-3.5 text-sm font-black text-amber-100 transition hover:bg-amber-500/20',
}: InstallAppButtonProps) {
  if (!canShowInstallButton) {
    return null;
  }

  return (
    <button type="button" onClick={onInstallClick} className={className}>
      <span className="inline-flex items-center justify-center gap-2">
        <span aria-hidden className="text-base leading-none">
          📲
        </span>
        {label}
      </span>
    </button>
  );
}
