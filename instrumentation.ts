export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { assertSqlRuntimeReady, SqlRuntimeMisconfiguredError } = await import(
    '@/lib/server/sqlRuntime'
  );

  try {
    assertSqlRuntimeReady('instrumentation');
  } catch (error) {
    if (error instanceof SqlRuntimeMisconfiguredError) {
      console.error('[SQL_RUNTIME] startup blocked:', error.message);
      throw error;
    }
    throw error;
  }
}
