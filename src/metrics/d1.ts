import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { cycleStartDate, utcToday } from '../graphql/queries.js';
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
      d1StorageAdaptiveGroups: {
        max: { databaseSizeBytes: number };
        dimensions: { databaseId: string };
      }[];
    }[];
  };
}

export const d1Module: ServiceModule = {
  name: 'd1',

  async fetchUsage(env: Env, cfg: AppConfig): Promise<MetricSample[]> {
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
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcToday(), end: utcToday() },
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
                dimensions { databaseId }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: cycleStartDate(cfg), end: utcToday() },
      ),
    ]);

    const opsRows = opsData.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? [];
    const rowReads = opsRows.reduce((sum, r) => sum + r.sum.rowsRead, 0);
    const rowWrites = opsRows.reduce((sum, r) => sum + r.sum.rowsWritten, 0);

    // The 5 GB free-tier limit is account-wide, so sum the per-database maxes —
    // an ungrouped max would only report the single largest database.
    const storageRows = storageData.viewer.accounts[0]?.d1StorageAdaptiveGroups ?? [];
    const perDatabaseMax = new Map<string, number>();
    for (const r of storageRows) {
      const id = r.dimensions.databaseId;
      perDatabaseMax.set(id, Math.max(perDatabaseMax.get(id) ?? 0, r.max.databaseSizeBytes));
    }
    let storageBytes = 0;
    for (const v of perDatabaseMax.values()) storageBytes += v;

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
