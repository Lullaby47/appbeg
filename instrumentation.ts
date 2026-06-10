export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { assertSqlRuntimeReady, SqlRuntimeMisconfiguredError } = await import(
    '@/lib/server/sqlRuntime'
  );
  const { assertRequiredSqlTables, SqlSchemaMissingError } = await import(
    '@/lib/server/sqlSchemaAudit'
  );
  const { assertAuthoritySqlSchema, AuthoritySchemaMissingError } = await import(
    '@/lib/server/authoritySchemaAudit'
  );
  const { isAuthoritySqlWriteEnabled } = await import('@/lib/server/sqlRuntime');

  try {
    assertSqlRuntimeReady('instrumentation');
    const { logSqlRuntimeDbAuditWithDatabase } = await import('@/lib/server/authoritySchemaAudit');
    await logSqlRuntimeDbAuditWithDatabase('instrumentation');
    if (isAuthoritySqlWriteEnabled()) {
      await assertAuthoritySqlSchema('instrumentation');
    } else {
      await assertRequiredSqlTables('instrumentation');
    }
  } catch (error) {
    if (
      error instanceof SqlRuntimeMisconfiguredError ||
      error instanceof SqlSchemaMissingError ||
      error instanceof AuthoritySchemaMissingError
    ) {
      console.error('[SQL_RUNTIME] startup blocked:', error.message);
      throw error;
    }
    throw error;
  }
}
