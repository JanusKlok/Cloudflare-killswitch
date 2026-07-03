import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcMonthStartDate, utcNow, utcToday } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

interface KvOpsData {
  viewer: {
    accounts: {
      kvOperationsAdaptiveGroups: {
        sum: { requests: number };
        dimensions: { actionType: string };
      }[];
    }[];
  };
}

interface KvStorageData {
  viewer: {
    accounts: {
      kvStorageAdaptiveGroups: {
        max: { byteCount: number };
        dimensions: { namespaceId: string };
      }[];
    }[];
  };
}

export const kvModule: ServiceModule = {
  name: 'kv',

  async fetchUsage(env: Env, _cfg: AppConfig): Promise<MetricSample[]> {
    const [opsData, storageData] = await Promise.all([
      gql<KvOpsData>(
        env,
        `query KvOps($accountTag: String!, $start: String!, $end: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              kvOperationsAdaptiveGroups(
                limit: 10000
                filter: { datetime_geq: $start, datetime_leq: $end }
              ) {
                sum { requests }
                dimensions { actionType }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcDayStart(), end: utcNow() },
      ),
      gql<KvStorageData>(
        env,
        `query KvStorage($accountTag: String!, $start: String!, $end: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              kvStorageAdaptiveGroups(
                limit: 10000
                filter: { date_geq: $start, date_leq: $end }
              ) {
                max { byteCount }
                dimensions { namespaceId }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcMonthStartDate(), end: utcToday() },
      ),
    ]);

    const opsRows = opsData.viewer.accounts[0]?.kvOperationsAdaptiveGroups ?? [];
    let reads = 0;
    let writes = 0;
    for (const row of opsRows) {
      const t = row.dimensions.actionType;
      if (t === 'read') reads += row.sum.requests;
      else if (t === 'write' || t === 'delete' || t === 'list') writes += row.sum.requests;
    }

    // The 1 GB free-tier limit is account-wide, so sum the per-namespace maxes —
    // an ungrouped max would only report the single largest namespace.
    const storageRows = storageData.viewer.accounts[0]?.kvStorageAdaptiveGroups ?? [];
    const perNamespaceMax = new Map<string, number>();
    for (const r of storageRows) {
      const id = r.dimensions.namespaceId;
      perNamespaceMax.set(id, Math.max(perNamespaceMax.get(id) ?? 0, r.max.byteCount));
    }
    let storageBytes = 0;
    for (const v of perNamespaceMax.values()) storageBytes += v;

    return [
      { metric: 'reads', value: reads, window: 'day' },
      { metric: 'writes', value: writes, window: 'day' },
      { metric: 'storageBytes', value: storageBytes, window: 'month' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('kv', s, cfg.limits.kv[s.metric as keyof typeof cfg.limits.kv]),
    );
  },
};
