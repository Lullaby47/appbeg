import 'server-only';

type PgErrorLike = {
  code?: string;
  message?: string;
  table?: string;
  column?: string;
};

export function extractPgErrorDetails(error: unknown) {
  const pg = (error && typeof error === 'object' ? error : {}) as PgErrorLike;
  return {
    errorCode: cleanText(pg.code) || null,
    errorMessage: error instanceof Error ? error.message : String(error || 'unknown_error'),
    table: cleanText(pg.table) || null,
    column: cleanText(pg.column) || null,
  };
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}
