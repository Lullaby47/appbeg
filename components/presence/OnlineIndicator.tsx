type Props = {
  online: boolean;
  /** e.g. `h-2.5 w-2.5` or `h-3 w-3` */
  sizeClassName?: string;
  ringClassName?: string;
  className?: string;
};

export function OnlineIndicator({
  online,
  sizeClassName = 'h-2.5 w-2.5',
  ringClassName = 'ring-neutral-950',
  className = '',
}: Props) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${sizeClassName} ring-2 ${ringClassName} ${
        online ? 'bg-emerald-500' : 'bg-neutral-500'
      } ${className}`.trim()}
      title={online ? 'Online' : 'Offline'}
      aria-label={online ? 'Online' : 'Offline'}
    />
  );
}
