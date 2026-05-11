import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcMonthStart, utcNow } from '../graphql/queries.js';
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
      kvStorageAdaptiveGroups: { max: { byteCount: number } }[];
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
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcMonthStart(), end: utcNow() },
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

    const storageRows = storageData.viewer.accounts[0]?.kvStorageAdaptiveGroups ?? [];
    const storageBytes = storageRows.reduce((max, r) => Math.max(max, r.max.byteCount), 0);

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
