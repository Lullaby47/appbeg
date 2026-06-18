/**
 * Quick sanity check for live stream client registry duplicate detection.
 * Run: node scripts/verify-live-stream-registry.mjs
 */

import assert from 'node:assert/strict';

// Inline minimal registry mirror for node (TS module is bundled in app only).
const activeByStreamKey = new Map();
let nextInstanceSeq = 0;

function createInstanceId(streamType) {
  nextInstanceSeq += 1;
  return `${streamType}-${nextInstanceSeq}`;
}

function registerOwner({ streamType, streamKey, instanceId, supersede }) {
  const existing = activeByStreamKey.get(streamKey);
  if (existing) {
    if (existing.instanceId === instanceId) {
      return 'duplicate_same_instance';
    }
    existing.supersede();
    activeByStreamKey.delete(streamKey);
  }
  activeByStreamKey.set(streamKey, { instanceId, streamType, streamKey, supersede });
  return 'claimed';
}

function releaseOwner({ streamKey, instanceId }) {
  const existing = activeByStreamKey.get(streamKey);
  if (existing?.instanceId === instanceId) {
    activeByStreamKey.delete(streamKey);
  }
}

const streamKey = 'carer-tasks:carer-a:coadmin-b';
let superseded = false;

const first = createInstanceId('carer_tasks');
registerOwner({
  streamType: 'carer_tasks',
  streamKey,
  instanceId: first,
  supersede: () => {
    superseded = true;
  },
});
assert.equal(activeByStreamKey.size, 1);

const second = createInstanceId('carer_tasks');
registerOwner({
  streamType: 'carer_tasks',
  streamKey,
  instanceId: second,
  supersede: () => undefined,
});
assert.equal(superseded, true, 'supersede should run for duplicate attach');
assert.equal(activeByStreamKey.size, 1);
assert.equal(activeByStreamKey.get(streamKey).instanceId, second);

releaseOwner({ streamKey, instanceId: second });
assert.equal(activeByStreamKey.size, 0);

console.info('[verify-live-stream-registry] ok');
