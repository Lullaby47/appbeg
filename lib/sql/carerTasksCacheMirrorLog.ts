import 'server-only';

export type CarerTaskMirrorBatchLogContext = {
  batchSize: number;
  batchIndex: number;
  totalBatches: number;
  taskCount: number;
  firstTaskId: string;
  lastTaskId: string;
};

let activeMirrorBatchLogContext: CarerTaskMirrorBatchLogContext | null = null;

export function setCarerTaskMirrorBatchLogContext(context: CarerTaskMirrorBatchLogContext | null) {
  activeMirrorBatchLogContext = context;
}

export function mirrorErrorLogFields(error: unknown) {
  const record =
    error instanceof Error
      ? (error as Error & {
          code?: string;
          detail?: string;
          constraint?: string;
          table?: string;
          column?: string;
        })
      : null;

  return {
    message: record?.message ?? String(error),
    stack: record?.stack ?? null,
    code: record?.code ?? null,
    detail: record?.detail ?? null,
    constraint: record?.constraint ?? null,
    table: record?.table ?? null,
    column: record?.column ?? null,
  };
}

export function mirrorBatchLogFields(taskId: string) {
  const context = activeMirrorBatchLogContext;
  if (context) {
    return {
      ...context,
      taskId,
    };
  }

  return {
    batchSize: 1,
    batchIndex: 1,
    totalBatches: 1,
    taskCount: 1,
    firstTaskId: taskId,
    lastTaskId: taskId,
    taskId,
  };
}

export async function runCarerTaskMirrorBatchItem<T>(
  taskIds: string[],
  batchIndex: number,
  taskId: string,
  run: () => Promise<T>
): Promise<T> {
  const totalBatches = taskIds.length;
  setCarerTaskMirrorBatchLogContext({
    batchSize: 1,
    batchIndex,
    totalBatches,
    taskCount: totalBatches,
    firstTaskId: taskIds[0] || taskId,
    lastTaskId: taskIds[totalBatches - 1] || taskId,
  });

  try {
    return await run();
  } finally {
    setCarerTaskMirrorBatchLogContext(null);
  }
}
