import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcMonthStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

interface D1OpsData {
  viewer: {
    accounts: {
      d1AnalyticsAdaptiveGroups: { sum: { rowsRead: number; rowsWritten: number } }[];
    }[];
  };
}

interface D1StorageData {
  viewer: {
    accounts: {
      d1StorageAdaptiveGroups: { max: { databaseSizeBytes: number } }[];
    }[];
  };
}

export const d1Module: ServiceModule = {
  name: 'd1',

  async fetchUsage(env: Env, _cfg: AppConfig): Promise<MetricSample[]> {
    const [opsData, storageData] = await Promise.all([
      gql<D1OpsData>(
        env,
        `query D1Ops($accountTag: String!, $start: String!, $end: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              d1AnalyticsAdaptiveGroups(
                limit: 10000
                filter: { date_geq: $start, date_leq: $end }
              ) {
                sum { rowsRead rowsWritten }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcDayStart(), end: utcNow() },
      ),
      gql<D1StorageData>(
        env,
        `query D1Storage($accountTag: String!, $start: String!, $end: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              d1StorageAdaptiveGroups(
                limit: 10000
                filter: { date_geq: $start, date_leq: $end }
              ) {
                max { databaseSizeBytes }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcMonthStart(), end: utcNow() },
      ),
    ]);

    const opsRows = opsData.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? [];
    const rowReads = opsRows.reduce((sum, r) => sum + r.sum.rowsRead, 0);
    const rowWrites = opsRows.reduce((sum, r) => sum + r.sum.rowsWritten, 0);

    // Sum databaseSizeBytes across all databases to get account-total D1 storage.
    const storageRows = storageData.viewer.accounts[0]?.d1StorageAdaptiveGroups ?? [];
    const storageBytes = storageRows.reduce((sum, r) => sum + r.max.databaseSizeBytes, 0);

    return [
      { metric: 'rowReads', value: rowReads, window: 'day' },
      { metric: 'rowWrites', value: rowWrites, window: 'day' },
      { metric: 'storageBytes', value: storageBytes, window: 'month' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('d1', s, cfg.limits.d1[s.metric as keyof typeof cfg.limits.d1]),
    );
  },
};
