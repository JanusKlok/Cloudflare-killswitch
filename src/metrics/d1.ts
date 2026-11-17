import type { AccountData, AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import { utcDaysAgo, utcToday } from '../graphql/queries.js';
import { STORAGE_WINDOW_DAYS, sumPerEntityMax } from './storage.js';
import { evaluateSample } from './evaluate.js';

interface D1Account {
  d1AnalyticsAdaptiveGroups?: { sum: { rowsRead: number; rowsWritten: number } }[];
  d1StorageAdaptiveGroups?: {
    max: { databaseSizeBytes: number };
    dimensions: { databaseId: string };
  }[];
}

export const d1Module: ServiceModule = {
  name: 'd1',

  query() {
    return {
      keys: ['d1AnalyticsAdaptiveGroups', 'd1StorageAdaptiveGroups'],
      selection: `d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $d1OpsStart, date_leq: $d1OpsEnd }
      ) {
        sum { rowsRead rowsWritten }
      }
      d1StorageAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $d1StorageStart, date_leq: $d1StorageEnd }
      ) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }`,
      variables: {
        d1OpsStart: { type: 'String!', value: utcToday() },
        d1OpsEnd: { type: 'String!', value: utcToday() },
        d1StorageStart: { type: 'String!', value: utcDaysAgo(STORAGE_WINDOW_DAYS) },
        d1StorageEnd: { type: 'String!', value: utcToday() },
      },
    };
  },

  parse(account: AccountData): MetricSample[] {
    const { d1AnalyticsAdaptiveGroups, d1StorageAdaptiveGroups } = account as D1Account;
    const opsRows = d1AnalyticsAdaptiveGroups ?? [];
    const rowReads = opsRows.reduce((sum, r) => sum + r.sum.rowsRead, 0);
    const rowWrites = opsRows.reduce((sum, r) => sum + r.sum.rowsWritten, 0);

    const storageBytes = sumPerEntityMax(
      'd1',
      'd1StorageAdaptiveGroups.max.databaseSizeBytes',
      d1StorageAdaptiveGroups ?? [],
      (r) => r.dimensions.databaseId,
      (r) => r.max.databaseSizeBytes,
      opsRows.length > 0,
    );

    return [
      { metric: 'rowReads', value: rowReads, window: 'day' },
      { metric: 'rowWrites', value: rowWrites, window: 'day' },
      { metric: 'storageBytes', value: storageBytes, window: 'cycle' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('d1', s, cfg.limits.d1[s.metric as keyof typeof cfg.limits.d1]),
    );
  },
};
