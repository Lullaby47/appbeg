import 'server-only';

export const AUTOMATION_AUTO_STATE_ROUTE_VERSION = 'sql_only_v2';

export function logAutomationAutoStateRouteVersion(input: {
  method: 'GET' | 'POST';
  sqlMode: boolean;
  carerUid: string | null;
  branch: string;
}) {
  console.info('[AUTOMATION_AUTO_STATE_ROUTE_VERSION]', {
    version: AUTOMATION_AUTO_STATE_ROUTE_VERSION,
    method: input.method,
    sqlMode: input.sqlMode,
    carerUid: input.carerUid,
    branch: input.branch,
    firestoreTouchAuditReachable: input.sqlMode ? false : true,
  });
}
