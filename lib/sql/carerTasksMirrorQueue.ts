import 'server-only';

import {
  isPgConnectionTimeoutError,
  logPlayerMirrorPoolStats,
} from '@/lib/sql/playerMirrorCommon';

const MAX_CONCURRENT = 2;
const QUEUE_WAIT_MS = 10_000;

/**
 * Failed carer task mirrors are best-effort. Repair with:
 *   node scripts/backfill-carer-tasks-cache.cjs --only-missing
 *   node scripts/compare-carer-tasks-cache.cjs
 */

class ConcurrencyLimiter {
  private active = 0;
  private waiters: Array<{ enqueuedAt: number; grant: () => void; reject: (error: Error) => void }> =
    [];

  constructor(
    private readonly max: number,
    private readonly waitMs: number,
    private readonly name: string
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({
        enqueuedAt: Date.now(),
        grant: () => {
          this.active += 1;
          resolve();
        },
        reject,
      });
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      const waitedMs = Date.now() - next.enqueuedAt;
      if (waitedMs > this.waitMs) {
        console.warn('[CARER_TASKS_MIRROR_QUEUE] skipped queue wait exceeded', {
          limiter: this.name,
          waitedMs,
          maxConcurrent: this.max,
          active: this.active,
          waitingCount: this.waiters.length,
        });
        logPlayerMirrorPoolStats('carer_tasks_mirror_queue_wait_exceeded');
        next.reject(new Error('carer task mirror queue wait exceeded'));
        continue;
      }
      next.grant();
      return;
    }
  }
}

const upsertLimiter = new ConcurrencyLimiter(MAX_CONCURRENT, QUEUE_WAIT_MS, 'carer_tasks_upsert');
const tombstoneLimiter = new ConcurrencyLimiter(MAX_CONCURRENT, QUEUE_WAIT_MS, 'carer_tasks_tombstone');

const upsertChains = new Map<string, Promise<boolean>>();
const tombstoneChains = new Map<string, Promise<boolean>>();
const pendingUpserts = new Map<string, unknown>();

function logMirrorQueueFailure(
  firebaseId: string,
  operation: 'upsert' | 'tombstone',
  error: unknown
) {
  if (isPgConnectionTimeoutError(error)) {
    logPlayerMirrorPoolStats(`carer_tasks_mirror_${operation}_timeout`);
  }
  console.error('[CARER_TASKS_CACHE] mirror failed', { firebaseId, operation, error });
}

export async function runQueuedCarerTaskUpsert<TPayload>(
  firebaseId: string,
  payload: TPayload,
  execute: (latestPayload: TPayload) => Promise<boolean>
): Promise<boolean> {
  const key = String(firebaseId || '').trim();
  if (!key) return false;

  pendingUpserts.set(key, payload);

  const inflight = upsertChains.get(key);
  if (inflight) {
    console.info('[CARER_TASKS_MIRROR_QUEUE] coalesced', {
      firebaseId: key,
      operation: 'upsert',
      reason: 'in_flight',
    });
    return inflight;
  }

  let chain!: Promise<boolean>;
  chain = upsertLimiter
    .run(async () => {
      let latest = pendingUpserts.get(key) as TPayload | undefined;
      let result = false;
      try {
        while (latest !== undefined) {
          pendingUpserts.delete(key);
          result = await execute(latest);
          latest = pendingUpserts.get(key) as TPayload | undefined;
          if (latest !== undefined) {
            console.info('[CARER_TASKS_MIRROR_QUEUE] coalesced', {
              firebaseId: key,
              operation: 'upsert',
              reason: 'pending_during_run',
            });
          }
        }
        return result;
      } catch (error) {
        logMirrorQueueFailure(key, 'upsert', error);
        return false;
      }
    })
    .finally(() => {
      if (upsertChains.get(key) === chain) {
        upsertChains.delete(key);
      }
    });

  upsertChains.set(key, chain);
  return chain;
}

export async function runQueuedCarerTaskTombstone(
  firebaseId: string,
  source: string,
  execute: (id: string, mirrorSource: string) => Promise<boolean>
): Promise<boolean> {
  const key = String(firebaseId || '').trim();
  if (!key) return false;

  const inflight = tombstoneChains.get(key);
  if (inflight) {
    console.info('[CARER_TASKS_MIRROR_QUEUE] coalesced', {
      firebaseId: key,
      operation: 'tombstone',
      reason: 'in_flight',
    });
    return inflight;
  }

  let chain!: Promise<boolean>;
  chain = tombstoneLimiter
    .run(async () => {
      try {
        return await execute(key, source);
      } catch (error) {
        logMirrorQueueFailure(key, 'tombstone', error);
        return false;
      }
    })
    .finally(() => {
      if (tombstoneChains.get(key) === chain) {
        tombstoneChains.delete(key);
      }
    });

  tombstoneChains.set(key, chain);
  return chain;
}

export async function mirrorCarerTaskIdsSequential(
  taskIds: string[],
  mirror: (taskId: string) => Promise<boolean>
) {
  let mirrored = 0;
  for (const taskId of taskIds) {
    if (await mirror(taskId)) {
      mirrored += 1;
    }
  }
  return mirrored;
}
