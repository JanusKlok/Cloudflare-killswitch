import type { AccountData, AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import { utcDayStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

interface WorkersAccount {
  workersInvocationsAdaptive?: { sum: { requests: number } }[];
}

export const workersModule: ServiceModule = {
  name: 'workers',

  query() {
    return {
      keys: ['workersInvocationsAdaptive'],
      selection: `workersInvocationsAdaptive(
        limit: 10000
        filter: { datetime_geq: $workersStart, datetime_leq: $workersEnd }
      ) {
        sum { requests }
      }`,
      variables: {
        workersStart: { type: 'String!', value: utcDayStart() },
        workersEnd: { type: 'String!', value: utcNow() },
      },
    };
  },

  parse(account: AccountData): MetricSample[] {
    const rows = (account as WorkersAccount).workersInvocationsAdaptive ?? [];
    const total = rows.reduce((sum, r) => sum + r.sum.requests, 0);
    return [{ metric: 'requests', value: total, window: 'day' }];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('workers', s, cfg.limits.workers[s.metric as keyof typeof cfg.limits.workers]),
    );
  },
};
