export const DEFAULT_MAINTENANCE_TITLE = 'Royal Vip Lounge is Under Maintenance';

export const DEFAULT_MAINTENANCE_MESSAGE =
  'We are currently performing maintenance and improvements to provide you with a better experience.\n\n' +
  'Some features may be temporarily unavailable during this time.\n\n' +
  'Please wait for a while and try again later.\n' +
  'Thank you for your patience and support.';

export type MaintenanceBreak = {
  enabled: boolean;
  title: string;
  message: string;
  startedAt?: unknown;
  startedBy?: string | null;
  endedAt?: unknown;
};

export function normalizeMaintenanceBreak(value: unknown): MaintenanceBreak {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const title = String(raw.title || '').trim() || DEFAULT_MAINTENANCE_TITLE;
  const message = String(raw.message || '').trim() || DEFAULT_MAINTENANCE_MESSAGE;
  return {
    enabled: raw.enabled === true,
    title,
    message,
    startedAt: raw.startedAt,
    startedBy: String(raw.startedBy || '').trim() || null,
    endedAt: raw.endedAt,
  };
}

export function maintenanceBreakResponse(message: string) {
  return {
    error: true,
    code: 'MAINTENANCE_BREAK',
    message: String(message || '').trim() || DEFAULT_MAINTENANCE_MESSAGE,
  };
}
