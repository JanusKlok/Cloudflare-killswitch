import type { AppConfig, Breach, MetricSample } from '../types.js';
import { evaluateSample } from './evaluate.js';
import type { ModuleOutcome } from './collect.js';

/** Pages Functions invocations bill against the Workers Free 100,000/day quota
 *  (https://developers.cloudflare.com/pages/functions/pricing/), so the sum of
 *  the two is what that quota sees.
 *
 *  UNVERIFIED: whether `workersInvocationsAdaptive` already includes Pages
 *  Functions invocations.  Cloudflare's docs do not say, and no scriptName
 *  pattern for Pages Functions is documented.  This is a plain sum; if the
 *  datasets overlap it double counts, which only makes the switch fire early,
 *  the safe direction.
 *
 *  Skipped, with an error, when either side is unavailable: a partial sum
 *  presented as complete could read "under the limit" while the real total is not. */
export function evaluateCombined(
  outcomes: Record<string, ModuleOutcome | undefined>,
  cfg: AppConfig,
): { breaches: Breach[]; errors: string[] } {
  const threshold = cfg.limits.combined?.requests;
  if (!threshold) return { breaches: [], errors: [] };

  const requestsOf = (name: string): number | undefined => {
    const outcome = outcomes[name];
    if (!outcome || 'error' in outcome) return undefined;
    return outcome.samples.find((s) => s.metric === 'requests')?.value;
  };

  const workers = requestsOf('workers');
  const pages = requestsOf('pages');
  if (workers === undefined || pages === undefined) {
    const missing = [workers === undefined && 'workers', pages === undefined && 'pages']
      .filter(Boolean)
      .join(' and ');
    return {
      breaches: [],
      errors: [`combined: skipped, ${missing} usage unavailable so the sum would be partial`],
    };
  }

  const sample: MetricSample = { metric: 'requests', value: workers + pages, window: 'day' };
  return { breaches: evaluateSample('combined', sample, threshold), errors: [] };
}
