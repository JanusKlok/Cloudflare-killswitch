import type { AccountData, AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import { utcDayStart, utcDaysAgo, utcNow, utcToday } from '../graphql/queries.js';
import { STORAGE_WINDOW_DAYS, sumPerEntityMax } from './storage.js';
import { evaluateSample } from './evaluate.js';

interface KvAccount {
  kvOperationsAdaptiveGroups?: {
    sum: { requests: number };
    dimensions: { actionType: string };
  }[];
  kvStorageAdaptiveGroups?: {
    max: { byteCount: number };
    dimensions: { namespaceId: string };
  }[];
}

export const kvModule: ServiceModule = {
  name: 'kv',

  query() {
    return {
      keys: ['kvOperationsAdaptiveGroups', 'kvStorageAdaptiveGroups'],
      selection: `kvOperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $kvOpsStart, datetime_leq: $kvOpsEnd }
      ) {
        sum { requests }
        dimensions { actionType }
      }
      kvStorageAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $kvStorageStart, date_leq: $kvStorageEnd }
      ) {
        max { byteCount }
        dimensions { namespaceId }
      }`,
      variables: {
        kvOpsStart: { type: 'String!', value: utcDayStart() },
        kvOpsEnd: { type: 'String!', value: utcNow() },
        kvStorageStart: { type: 'String!', value: utcDaysAgo(STORAGE_WINDOW_DAYS) },
        kvStorageEnd: { type: 'String!', value: utcToday() },
      },
    };
  },

  parse(account: AccountData): MetricSample[] {
    const { kvOperationsAdaptiveGroups, kvStorageAdaptiveGroups } = account as KvAccount;
    const opsRows = kvOperationsAdaptiveGroups ?? [];
    const counts = { read: 0, write: 0, delete: 0, list: 0 };
    for (const row of opsRows) {
      const t = row.dimensions.actionType;
      if (Object.hasOwn(counts, t)) counts[t as keyof typeof counts] += row.sum.requests;
      else
        console.warn(
          `kv: unrecognised actionType "${t}" (${row.sum.requests} requests) not counted`,
        );
    }

    const storageBytes = sumPerEntityMax(
      'kv',
      'kvStorageAdaptiveGroups.max.byteCount',
      kvStorageAdaptiveGroups ?? [],
      (r) => r.dimensions.namespaceId,
      (r) => r.max.byteCount,
      opsRows.length > 0,
    );

    return [
      { metric: 'reads', value: counts.read, window: 'day' },
      { metric: 'writes', value: counts.write, window: 'day' },
      { metric: 'deletes', value: counts.delete, window: 'day' },
      { metric: 'lists', value: counts.list, window: 'day' },
      { metric: 'storageBytes', value: storageBytes, window: 'cycle' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('kv', s, cfg.limits.kv[s.metric as keyof typeof cfg.limits.kv]),
    );
  },
};
