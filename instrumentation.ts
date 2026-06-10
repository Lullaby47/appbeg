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

  try {
    assertSqlRuntimeReady('instrumentation');
    await assertRequiredSqlTables('instrumentation');
  } catch (error) {
    if (error instanceof SqlRuntimeMisconfiguredError || error instanceof SqlSchemaMissingError) {
      console.error('[SQL_RUNTIME] startup blocked:', error.message);
      throw error;
    }
    throw error;
  }
}
