import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

interface WorkersData {
  viewer: {
    accounts: {
      workersInvocationsAdaptive: { sum: { requests: number } }[];
    }[];
  };
}

export const workersModule: ServiceModule = {
  name: 'workers',

  async fetchUsage(env: Env, _cfg: AppConfig): Promise<MetricSample[]> {
    const data = await gql<WorkersData>(
      env,
      `query WorkersUsage($accountTag: String!, $start: String!, $end: String!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsAdaptive(
              limit: 10000
              filter: { datetime_geq: $start, datetime_leq: $end }
            ) {
              sum { requests }
            }
          }
        }
      }`,
      {
        accountTag: env.CLOUDFLARE_ACCOUNT_ID,
        start: utcDayStart(),
        end: utcNow(),
      },
    );

    const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
    const total = rows.reduce((sum, r) => sum + r.sum.requests, 0);
    return [{ metric: 'requests', value: total, window: 'day' }];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('workers', s, cfg.limits.workers[s.metric as keyof typeof cfg.limits.workers]),
    );
  },
};
