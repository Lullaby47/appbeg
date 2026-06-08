export type CarerPageStartupStage =
  | 'mount'
  | 'session_user_loaded'
  | 'actor_ready'
  | 'base_data_start'
  | 'base_data_done'
  | 'task_sync_start'
  | 'task_sync_done'
  | 'ready_after_base_data'
  | 'bootstrap_complete'
  | 'auto_tick_token_start'
  | 'auto_tick_token_done'
  | 'jobs_snapshot_start'
  | 'jobs_snapshot_done'
  | 'tasks_snapshot_start'
  | 'tasks_snapshot_done'
  | 'sse_connected'
  | 'sse_start'
  | 'session_me'
  | 'base_data'
  | 'auto_tick_token'
  | 'jobs_snapshot'
  | 'tasks_snapshot'
  | 'ready';

export type CarerPageStartupTimingFields = {
  profile_ms: number | null;
  base_data_ms: number | null;
  automation_jobs_ms: number | null;
  tasks_ms: number | null;
  stream_ms: number | null;
  task_sync_ms: number | null;
  ready_ms: number | null;
};

type CarerPageStartupTimingState = CarerPageStartupTimingFields & {
  startedAt: number;
  readyLogged: boolean;
  streamRecorded: boolean;
};

let timingState: CarerPageStartupTimingState | null = null;

export function resetCarerPageStartupTiming() {
  timingState = {
    startedAt: Date.now(),
    profile_ms: null,
    base_data_ms: null,
    automation_jobs_ms: null,
    tasks_ms: null,
    stream_ms: null,
    task_sync_ms: null,
    ready_ms: null,
    readyLogged: false,
    streamRecorded: false,
  };
}

export function getCarerPageStartupTiming(): CarerPageStartupTimingFields {
  if (!timingState) {
    return {
      profile_ms: null,
      base_data_ms: null,
      automation_jobs_ms: null,
      tasks_ms: null,
      stream_ms: null,
      task_sync_ms: null,
      ready_ms: null,
    };
  }
  return {
    profile_ms: timingState.profile_ms,
    base_data_ms: timingState.base_data_ms,
    automation_jobs_ms: timingState.automation_jobs_ms,
    tasks_ms: timingState.tasks_ms,
    stream_ms: timingState.stream_ms,
    task_sync_ms: timingState.task_sync_ms,
    ready_ms: timingState.ready_ms,
  };
}

function markTimingField(field: keyof CarerPageStartupTimingFields, ms: number) {
  if (!timingState) {
    return;
  }
  timingState[field] = ms;
}

export function markCarerPageStartupStreamConnected(channel: string) {
  if (!timingState || timingState.streamRecorded) {
    return;
  }
  timingState.streamRecorded = true;
  timingState.stream_ms = Date.now() - timingState.startedAt;
  logCarerPageStartupTimingSummary('sse_connected', { channel });
}

export function logCarerPageStartupTimingSummary(
  phase: CarerPageStartupStage | 'ready' | 'bootstrap_complete',
  extra?: Record<string, unknown>
) {
  const timing = getCarerPageStartupTiming();
  console.info(
    `[CARER_PAGE_STARTUP] ${JSON.stringify({
      phase,
      ...timing,
      ...(extra || {}),
    })}`
  );
}

export function tryLogCarerPageStartupReady(extra?: Record<string, unknown>) {
  if (!timingState || timingState.readyLogged) {
    return;
  }
  timingState.readyLogged = true;
  timingState.ready_ms = Date.now() - timingState.startedAt;
  logCarerPageStartupTimingSummary('ready', extra);
}

export function logCarerPageStartup(input: {
  stage: CarerPageStartupStage;
  ok: boolean;
  uid?: string | null;
  role?: string | null;
  reason?: string | null;
  durationMs?: number;
  error_code?: string | null;
  firestore_code?: string | null;
  extra?: Record<string, unknown>;
}) {
  const durationMs = input.durationMs ?? null;

  if (timingState && typeof durationMs === 'number') {
    if (input.stage === 'actor_ready' && input.ok) {
      markTimingField('profile_ms', durationMs);
    }
    if (input.stage === 'base_data_done' && input.ok) {
      markTimingField('base_data_ms', durationMs);
    }
    if (input.stage === 'jobs_snapshot_done' && input.ok) {
      markTimingField('automation_jobs_ms', durationMs);
    }
    if (input.stage === 'tasks_snapshot_done' && input.ok) {
      markTimingField('tasks_ms', durationMs);
    }
    if (input.stage === 'task_sync_done') {
      markTimingField('task_sync_ms', durationMs);
    }
  }

  console.info(
    `[CARER_PAGE_STARTUP] ${JSON.stringify({
      stage: input.stage,
      ok: input.ok,
      uid: input.uid ?? null,
      role: input.role ?? null,
      reason: input.reason ?? input.error_code ?? null,
      durationMs,
      error_code: input.error_code ?? null,
      firestore_code: input.firestore_code ?? null,
      ...getCarerPageStartupTiming(),
      ...(input.extra || {}),
    })}`
  );

  if (input.stage === 'base_data_done' && input.ok) {
    logCarerPageStartupTimingSummary('base_data_done');
  }
  if (input.stage === 'bootstrap_complete') {
    logCarerPageStartupTimingSummary('bootstrap_complete', input.extra);
  }
}

export function logCarerPageTaskSync(input: {
  stage: 'start' | 'done' | 'error';
  ok?: boolean;
  durationMs?: number;
  error_code?: string | null;
  firestore_code?: string | number | null;
  coadminUid?: string | null;
  pendingRequestsCount?: number;
}) {
  console.info(
    `[CARER_PAGE_TASK_SYNC] ${JSON.stringify({
      stage: input.stage,
      ok: input.ok ?? input.stage === 'done',
      durationMs: input.durationMs ?? null,
      error_code: input.error_code ?? null,
      firestore_code: input.firestore_code ?? null,
      coadminUid: input.coadminUid ?? null,
      pendingRequestsCount: input.pendingRequestsCount ?? null,
    })}`
  );
}
