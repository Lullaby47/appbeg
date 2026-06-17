import 'server-only';

const INSTRUMENTATION_SQL_AUDIT_TIMEOUT_MS = 4_000;

function isSqlRuntimeConfigError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'SqlRuntimeMisconfiguredError' ||
      error.name === 'SqlSchemaMissingError' ||
      error.name === 'AuthoritySchemaMissingError')
  );
}

function timeoutAfter(ms: number, label: string) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
}

async function runInstrumentationSqlAudit() {
  const { isAuthoritySqlWriteEnabled } = await import('@/lib/server/sqlRuntime');
  const { assertRequiredSqlTables } = await import('@/lib/server/sqlSchemaAudit');
  const { assertAuthoritySqlSchema, logSqlRuntimeDbAuditWithDatabase } = await import(
    '@/lib/server/authoritySchemaAudit'
  );

  await logSqlRuntimeDbAuditWithDatabase('instrumentation');
  if (isAuthoritySqlWriteEnabled()) {
    await assertAuthoritySqlSchema('instrumentation');
  } else {
    await assertRequiredSqlTables('instrumentation');
  }
}

function isEnabledEnv(value: string | undefined) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function logSqlPublicEnvMismatch() {
  const sqlOnlyMode = isEnabledEnv(process.env.APPBEG_SQL_ONLY_MODE);
  if (!sqlOnlyMode) {
    return;
  }

  const publicSqlLoginFirst = isEnabledEnv(process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST);
  const publicSqlPlayerLogin = isEnabledEnv(process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN);
  const publicSqlReadMode =
    isEnabledEnv(process.env.NEXT_PUBLIC_SQL_READ_MODE) ||
    publicSqlLoginFirst ||
    publicSqlPlayerLogin;

  if (publicSqlLoginFirst && publicSqlPlayerLogin && publicSqlReadMode) {
    return;
  }

  console.warn('[SQL_ENV_MISMATCH]', {
    appbegSqlOnlyMode: true,
    nextPublicSqlLoginFirst: publicSqlLoginFirst,
    nextPublicSqlPlayerLogin: publicSqlPlayerLogin,
    nextPublicSqlReadMode: publicSqlReadMode,
    explanation:
      'APPBEG_SQL_ONLY_MODE=1 requires browser SQL flags. Set NEXT_PUBLIC_SQL_LOGIN_FIRST=1, NEXT_PUBLIC_SQL_PLAYER_LOGIN=1, and NEXT_PUBLIC_SQL_READ_MODE=1, then restart Next.js.',
  });
}

function logSqlOnlyVerification() {
  const required = {
    APPBEG_SQL_ONLY_MODE: process.env.APPBEG_SQL_ONLY_MODE,
    ALLOW_FIREBASE_FALLBACK: process.env.ALLOW_FIREBASE_FALLBACK,
    AUTH_SQL_READ: process.env.AUTH_SQL_READ,
    APP_SESSION_SQL_READ: process.env.APP_SESSION_SQL_READ,
    PLAYER_SESSION_SQL_READ: process.env.PLAYER_SESSION_SQL_READ,
    NEXT_PUBLIC_SQL_LOGIN_FIRST: process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST,
    NEXT_PUBLIC_SQL_PLAYER_LOGIN: process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN,
  };
  const expected: Record<keyof typeof required, string> = {
    APPBEG_SQL_ONLY_MODE: '1',
    ALLOW_FIREBASE_FALLBACK: '0',
    AUTH_SQL_READ: '1',
    APP_SESSION_SQL_READ: '1',
    PLAYER_SESSION_SQL_READ: '1',
    NEXT_PUBLIC_SQL_LOGIN_FIRST: '1',
    NEXT_PUBLIC_SQL_PLAYER_LOGIN: '1',
  };
  const mismatches = Object.entries(required)
    .filter(([key, value]) => String(value || '').trim() !== expected[key as keyof typeof expected])
    .map(([key, value]) => ({
      variable: key,
      expected: expected[key as keyof typeof expected],
      actual: String(value || '').trim() || '<unset>',
    }));

  if (mismatches.length) {
    console.warn('[ENV_SQL_ONLY_MISMATCH]', {
      mismatches,
      databaseUrlConfigured: Boolean(String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim()),
    });
    return;
  }

  console.info('[ENV_SQL_ONLY_VERIFIED]', {
    appbegSqlOnlyMode: true,
    allowFirebaseFallback: false,
    authSqlRead: true,
    appSessionSqlRead: true,
    playerSessionSqlRead: true,
    nextPublicSqlLoginFirst: true,
    nextPublicSqlPlayerLogin: true,
    databaseUrlConfigured: Boolean(String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim()),
  });
}

export async function registerNodeInstrumentation() {
  const { assertSqlRuntimeReady, SqlRuntimeMisconfiguredError } = await import(
    '@/lib/server/sqlRuntime'
  );
  const { logAppbegSqlOnlyModeStartup } = await import('@/lib/server/appbegSqlOnlyMode');

  logAppbegSqlOnlyModeStartup('instrumentation');
  logSqlPublicEnvMismatch();
  logSqlOnlyVerification();

  try {
    assertSqlRuntimeReady('instrumentation');
  } catch (error) {
    if (error instanceof SqlRuntimeMisconfiguredError) {
      console.error('[SQL_RUNTIME] startup blocked:', error.message);
      throw error;
    }
    throw error;
  }

  void Promise.race([
    runInstrumentationSqlAudit(),
    timeoutAfter(INSTRUMENTATION_SQL_AUDIT_TIMEOUT_MS, 'instrumentation_sql_audit'),
  ]).catch((error) => {
    if (isSqlRuntimeConfigError(error)) {
      console.error('[SQL_RUNTIME] instrumentation audit blocked:', error.message);
      return;
    }
    console.warn('[SQL_RUNTIME] instrumentation audit deferred (non-blocking)', {
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
