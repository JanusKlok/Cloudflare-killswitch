import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcDaysAgo, utcNow, utcToday } from '../graphql/queries.js';
import { STORAGE_WINDOW_DAYS, sumPerEntityMax } from './storage.js';
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
        {
          accountTag: env.CLOUDFLARE_ACCOUNT_ID,
          start: utcDaysAgo(STORAGE_WINDOW_DAYS),
          end: utcToday(),
        },
      ),
    ]);

    const opsRows = opsData.viewer.accounts[0]?.kvOperationsAdaptiveGroups ?? [];
    let reads = 0;
    let writes = 0;
    for (const row of opsRows) {
      const t = row.dimensions.actionType;
      if (t === 'read') reads += row.sum.requests;
      // Cloudflare meters write, delete and list separately; they are summed
      // into one counter here, so the effective `writes` limit is the sum of
      // all three. Deliberately conservative — it fires early, not late.
      else if (t === 'write' || t === 'delete' || t === 'list') writes += row.sum.requests;
      else
        console.warn(
          `kv: unrecognised actionType "${t}" (${row.sum.requests} requests) not counted`,
        );
    }

    const storageRows = storageData.viewer.accounts[0]?.kvStorageAdaptiveGroups ?? [];
    const storageBytes = sumPerEntityMax(
      'kv',
      'kvStorageAdaptiveGroups.max.byteCount',
      storageRows,
      (r) => r.dimensions.namespaceId,
      (r) => r.max.byteCount,
      opsRows.length > 0,
    );

    return [
      { metric: 'reads', value: reads, window: 'day' },
      { metric: 'writes', value: writes, window: 'day' },
      { metric: 'storageBytes', value: storageBytes, window: 'cycle' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('kv', s, cfg.limits.kv[s.metric as keyof typeof cfg.limits.kv]),
    );
  },
};
