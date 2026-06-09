export const LIVE_STREAM_DISABLED =
  String(process.env.NEXT_PUBLIC_DISABLE_LIVE_STREAM || '').trim() === '1';
