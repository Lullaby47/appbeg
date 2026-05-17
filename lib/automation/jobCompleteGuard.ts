export function jobCompleteGuard(taskId: string, latestTask: Record<string, any> | null, jobId: string) {
  const latestStatus = String(latestTask?.status || '').trim().toLowerCase();
  const latestAutomationJobId = String(latestTask?.automationJobId || '').trim() || null;
  const latestLinkedJobId = String(latestTask?.linkedJobId || '').trim() || null;
  console.info(
    '[JOB_COMPLETE_GUARD] taskId=%s jobId=%s latestStatus=%s latestAutomationJobId=%s latestLinkedJobId=%s',
    taskId,
    jobId,
    latestStatus || null,
    latestAutomationJobId || null,
    latestLinkedJobId || null
  );
  if (latestStatus === 'pending') {
    console.info('[JOB_COMPLETE_GUARD] abort reason=pending_reset taskId=%s jobId=%s', taskId, jobId);
    return false;
  }
  if (latestAutomationJobId && latestAutomationJobId !== jobId) {
    console.info(
      '[JOB_COMPLETE_GUARD] abort reason=automation_job_id_mismatch taskId=%s jobId=%s latestAutomationJobId=%s',
      taskId,
      jobId,
      latestAutomationJobId
    );
    return false;
  }
  if (latestLinkedJobId && latestLinkedJobId !== jobId) {
    console.info(
      '[JOB_COMPLETE_GUARD] abort reason=linked_job_id_mismatch taskId=%s jobId=%s latestLinkedJobId=%s',
      taskId,
      jobId,
      latestLinkedJobId
    );
    return false;
  }
  console.info('[JOB_COMPLETE_GUARD] applying completion taskId=%s jobId=%s', taskId, jobId);
  return true;
}
