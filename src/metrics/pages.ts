import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

// NOTE: This tracks Pages *Functions* invocations via the GraphQL Analytics API.
// Static asset requests to Pages sites are NOT counted here — they are served
// directly from Cloudflare's CDN and do not appear in this dataset.
// Cloudflare's free-tier "100,000 requests/day" limit refers to Functions
// invocations for accounts using Pages Functions.

interface PagesData {
  viewer: {
    accounts: {
      pagesFunctionsInvocationsAdaptiveGroups: { sum: { requests: number } }[];
    }[];
  };
}

export const pagesModule: ServiceModule = {
  name: 'pages',

  async fetchUsage(env: Env, _cfg: AppConfig): Promise<MetricSample[]> {
    const data = await gql<PagesData>(
      env,
      `query PagesUsage($accountTag: String!, $start: String!, $end: String!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            pagesFunctionsInvocationsAdaptiveGroups(
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

    const rows = data.viewer.accounts[0]?.pagesFunctionsInvocationsAdaptiveGroups ?? [];
    const total = rows.reduce((sum, r) => sum + r.sum.requests, 0);
    return [{ metric: 'requests', value: total, window: 'day' }];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('pages', s, cfg.limits.pages[s.metric as keyof typeof cfg.limits.pages]),
    );
  },
};
