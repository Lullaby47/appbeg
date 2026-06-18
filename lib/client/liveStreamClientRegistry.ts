export type LiveStreamClientType = 'carer_tasks' | 'carer_jobs';

type LiveStreamRegistryEntry = {
  instanceId: string;
  streamType: LiveStreamClientType;
  streamKey: string;
  supersede: () => void;
};

let nextInstanceSeq = 0;

const activeByStreamKey = new Map<string, LiveStreamRegistryEntry>();

export function createLiveStreamClientInstanceId(streamType: LiveStreamClientType) {
  nextInstanceSeq += 1;
  return `${streamType}-${nextInstanceSeq}`;
}

export function buildCarerTaskStreamKey(carerUid: string, coadminUid: string) {
  return `carer-tasks:${carerUid}:${coadminUid}`;
}

export function buildCarerJobStreamKey(carerUid: string) {
  return `carer-jobs:${carerUid}`;
}

export function registerLiveStreamClientOwner(input: {
  streamType: LiveStreamClientType;
  streamKey: string;
  instanceId: string;
  reason: string;
  supersede: () => void;
}): 'claimed' | 'duplicate_same_instance' {
  const existing = activeByStreamKey.get(input.streamKey);
  if (existing) {
    if (existing.instanceId === input.instanceId) {
      return 'duplicate_same_instance';
    }
    console.info('[DUPLICATE_STREAM_DETECTED]', {
      streamType: input.streamType,
      existingInstanceId: existing.instanceId,
      newInstanceId: input.instanceId,
      streamKey: input.streamKey,
      reason: input.reason,
    });
    existing.supersede();
    activeByStreamKey.delete(input.streamKey);
  }

  activeByStreamKey.set(input.streamKey, {
    instanceId: input.instanceId,
    streamType: input.streamType,
    streamKey: input.streamKey,
    supersede: input.supersede,
  });

  return 'claimed';
}

export function logLiveStreamClientConnect(input: {
  streamType: LiveStreamClientType;
  instanceId: string;
  reason: string;
  streamKey: string;
}) {
  console.info('[LIVE_STREAM_CLIENT_CONNECT]', {
    streamType: input.streamType,
    instanceId: input.instanceId,
    reason: input.reason,
    streamKey: input.streamKey,
  });
}

export function releaseLiveStreamClientOwner(input: {
  streamType: LiveStreamClientType;
  streamKey: string;
  instanceId: string;
  reason: string;
}) {
  const existing = activeByStreamKey.get(input.streamKey);
  if (!existing || existing.instanceId !== input.instanceId) {
    return;
  }
  activeByStreamKey.delete(input.streamKey);
  console.info('[LIVE_STREAM_CLIENT_DISCONNECT]', {
    streamType: input.streamType,
    instanceId: input.instanceId,
    reason: input.reason,
    streamKey: input.streamKey,
  });
}

export function logLiveStreamClientReconnect(input: {
  streamType: LiveStreamClientType;
  instanceId: string;
  reason: string;
  streamKey?: string;
  extra?: Record<string, unknown>;
}) {
  console.info('[LIVE_STREAM_CLIENT_RECONNECT]', {
    streamType: input.streamType,
    instanceId: input.instanceId,
    reason: input.reason,
    ...(input.streamKey ? { streamKey: input.streamKey } : {}),
    ...(input.extra || {}),
  });
}

export const LIVE_STREAM_CLIENT_CLEANUP_DELAY_MS = 50;
