export function verifyAgentTickSecret(request: Request): boolean {
  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  const ok = Boolean(expected && provided && provided === expected);
  if (ok) {
    console.info('[AGENT_JOBS_API_AUTH_OK]', {
      hasExpected: true,
      hasProvided: true,
      expectedPrefix: expected.slice(0, 4),
      providedPrefix: provided.slice(0, 4),
    });
  } else {
    console.info('[AGENT_JOBS_API_AUTH_OK]', {
      ok: false,
      hasExpected: Boolean(expected),
      hasProvided: Boolean(provided),
      expectedPrefix: expected ? expected.slice(0, 4) : null,
      providedPrefix: provided ? provided.slice(0, 4) : null,
    });
  }
  return ok;
}
