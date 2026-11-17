import type { AccountData, AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import { utcDayStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

// NOTE: This tracks Pages *Functions* invocations via the GraphQL Analytics API.
// Static asset requests to Pages sites are NOT counted here — they are served
// directly from Cloudflare's CDN and do not appear in this dataset.
// Cloudflare's free-tier "100,000 requests/day" limit refers to Functions
// invocations for accounts using Pages Functions.

interface PagesAccount {
  pagesFunctionsInvocationsAdaptiveGroups?: { sum: { requests: number } }[];
}

export const pagesModule: ServiceModule = {
  name: 'pages',

  query() {
    return {
      keys: ['pagesFunctionsInvocationsAdaptiveGroups'],
      selection: `pagesFunctionsInvocationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $pagesStart, datetime_leq: $pagesEnd }
      ) {
        sum { requests }
      }`,
      variables: {
        pagesStart: { type: 'String!', value: utcDayStart() },
        pagesEnd: { type: 'String!', value: utcNow() },
      },
    };
  },

  parse(account: AccountData): MetricSample[] {
    const rows = (account as PagesAccount).pagesFunctionsInvocationsAdaptiveGroups ?? [];
    const total = rows.reduce((sum, r) => sum + r.sum.requests, 0);
    return [{ metric: 'requests', value: total, window: 'day' }];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('pages', s, cfg.limits.pages[s.metric as keyof typeof cfg.limits.pages]),
    );
  },
};
