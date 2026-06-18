import type { PoolClient } from 'pg';

import { runMirrorClientQuery } from '@/lib/sql/playerMirrorCommon';

type PlanNode = {
  ['Node Type']?: string;
  ['Index Name']?: string;
  ['Relation Name']?: string;
  ['Actual Rows']?: number;
  ['Plan Rows']?: number;
  ['Actual Total Time']?: number;
  Plans?: PlanNode[];
};

function shouldLogSqlExplainSummary() {
  return process.env.SQL_QUERY_PLAN_DEBUG === '1' || process.env.SNAPSHOT_SQL_EXPLAIN === '1';
}

function collectPlanSummary(node: PlanNode | null | undefined) {
  const stack = node ? [node] : [];
  let rowsScanned = 0;
  const planTypes = new Set<string>();
  const usedIndexes = new Set<string>();

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const nodeType = String(current['Node Type'] || '').trim();
    if (nodeType) {
      planTypes.add(nodeType);
    }
    const indexName = String(current['Index Name'] || '').trim();
    if (indexName) {
      usedIndexes.add(indexName);
    }
    rowsScanned += Number(current['Actual Rows'] ?? current['Plan Rows'] ?? 0) || 0;
    for (const child of current.Plans || []) {
      stack.push(child);
    }
  }

  return {
    planType: Array.from(planTypes).join(' > ') || null,
    usedIndex: Array.from(usedIndexes).join(', ') || null,
    rowsScanned,
  };
}

export async function logSqlExplainSummary(input: {
  client: PoolClient;
  route: string;
  queryName: string;
  sql: string;
  params: unknown[];
  rowsReturned: number;
}) {
  if (!shouldLogSqlExplainSummary()) {
    return;
  }

  try {
    const explain = await runMirrorClientQuery<Record<string, unknown>>(
      input.client,
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${input.sql}`,
      input.params
    );
    const payload = explain.rows[0]?.['QUERY PLAN'];
    const firstPlan = Array.isArray(payload) ? (payload[0] as Record<string, unknown>) : null;
    const plan = firstPlan?.Plan as PlanNode | undefined;
    const summary = collectPlanSummary(plan);
    console.info('[SQL_EXPLAIN_SUMMARY]', {
      route: input.route,
      queryName: input.queryName,
      planType: summary.planType,
      usedIndex: summary.usedIndex,
      rowsScanned: summary.rowsScanned,
      rowsReturned: input.rowsReturned,
      executionMs: Number(firstPlan?.['Execution Time'] || 0),
      explainQueryMs: explain.timing.query_exec_ms,
    });
  } catch (error) {
    console.info('[SQL_EXPLAIN_SUMMARY]', {
      route: input.route,
      queryName: input.queryName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
