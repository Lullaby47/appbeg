import 'server-only';

export type RechargeSqlWaterfallEntry = {
  step: string;
  table: string;
  queryType: 'read' | 'write' | 'txn';
  durationMs: number;
  sequentialOrParallel: 'sequential' | 'parallel';
  required: boolean;
  canMoveAfterResponse: boolean;
};

export class RechargeSqlWaterfall {
  private readonly entries: RechargeSqlWaterfallEntry[] = [];

  async time<T>(
    entry: Omit<RechargeSqlWaterfallEntry, 'durationMs'>,
    run: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      const row: RechargeSqlWaterfallEntry = {
        ...entry,
        durationMs: Date.now() - startedAt,
      };
      this.entries.push(row);
      console.info('[RECHARGE_SQL_WATERFALL]', row);
    }
  }

  flushSummary() {
    if (!this.entries.length) {
      return;
    }
    console.info('[RECHARGE_SQL_WATERFALL_SUMMARY]', {
      stepCount: this.entries.length,
      totalMs: this.entries.reduce((sum, row) => sum + row.durationMs, 0),
      steps: this.entries,
    });
  }
}
