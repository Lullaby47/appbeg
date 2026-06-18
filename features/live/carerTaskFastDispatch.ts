type SqlTaskPayload = {
  entityId?: unknown;
  taskId?: unknown;
  status?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

const FAST_DISPATCH_EVENTS = new Set([
  'task.upserted',
  'task.returned_to_pending',
  'recharge_task_create',
  'redeem_task_create',
  'recharge_create',
  'redeem_create',
]);

export type CarerTaskFastDispatchSignal = {
  eventName: string;
  taskId: string;
  outboxId: number;
  receivedAt: number;
};

export function shouldFastDispatchForCarerTaskLiveEvent(
  eventName: string,
  payload: SqlTaskPayload
) {
  if (!FAST_DISPATCH_EVENTS.has(eventName)) {
    return false;
  }
  if (eventName === 'task.upserted' || eventName === 'task.returned_to_pending') {
    const status = cleanText(payload.status).toLowerCase();
    return !status || status === 'pending';
  }
  return true;
}
