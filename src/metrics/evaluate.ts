import type { Breach, MetricSample, Threshold } from '../types.js';

/**
 * Given a single metric sample and its threshold configuration, emit zero or
 * one Breach.  Returns [] if the value is within limits.
 *
 * Rules:
 *  - value >= purgeAt (when set) → severity 'purge'
 *  - value >= blockAt (but below purgeAt, or purgeAt unset) → severity 'block'
 */
export function evaluateSample(
  service: string,
  sample: MetricSample,
  threshold: Threshold | undefined,
): Breach[] {
  if (!threshold) return [];
  const { blockAt, purgeAt } = threshold;

  if (purgeAt !== undefined && sample.value >= purgeAt) {
    return [
      {
        service,
        metric: sample.metric,
        observed: sample.value,
        limit: purgeAt,
        severity: 'purge',
        window: sample.window,
      },
    ];
  }

  if (sample.value >= blockAt) {
    return [
      {
        service,
        metric: sample.metric,
        observed: sample.value,
        limit: blockAt,
        severity: 'block',
        window: sample.window,
      },
    ];
  }

  return [];
}
