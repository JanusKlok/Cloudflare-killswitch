import type { AccountData, AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import { cycleStart, utcHoursAgo, utcNow } from '../graphql/queries.js';
import { STORAGE_WINDOW_HOURS, sumPerEntityMax } from './storage.js';
import { evaluateSample } from './evaluate.js';

// R2 operation classification.
// Source: https://developers.cloudflare.com/r2/pricing/ (verified 2026-11-17).
// Class A: higher price per million, smaller free quota. This is NOT "mutating
// operations": list operations are Class A and deletes are free.
// Class B: reads and metadata lookups. Free: counted in neither class.
// The analytics docs only say actionType is "the name of the operation", so
// names that appear on the S3 compatibility page but not the pricing page
// (aliases) are mapped to their pricing-page counterpart.
const CLASS_A_OPS = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
  // Aliases (S3 API page names, absent from the pricing page).
  'ListObjectsV2', // same operation family as ListObjects
  'CreateBucket', // same as PutBucket
  // Unconfirmed: not on the pricing page, so classed A conservatively.
  'DeleteBucketCors',
  'DeleteBucketLifecycleConfiguration',
]);

const CLASS_B_OPS = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

const FREE_OPS = new Set([
  'DeleteObject',
  'DeleteBucket',
  'AbortMultipartUpload',
  'DeleteObjects', // alias: batch form of DeleteObject
]);

interface R2Account {
  r2OperationsAdaptiveGroups?: {
    sum: { requests: number };
    dimensions: { actionType: string };
  }[];
  r2StorageAdaptiveGroups?: {
    max: { payloadSize: number };
    dimensions: { bucketName: string };
  }[];
}

export const r2Module: ServiceModule = {
  name: 'r2',

  query(cfg: AppConfig) {
    return {
      keys: ['r2OperationsAdaptiveGroups', 'r2StorageAdaptiveGroups'],
      selection: `r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $r2OpsStart, datetime_leq: $r2OpsEnd }
      ) {
        sum { requests }
        dimensions { actionType }
      }
      r2StorageAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $r2StorageStart, datetime_leq: $r2StorageEnd }
      ) {
        max { payloadSize }
        dimensions { bucketName }
      }`,
      variables: {
        r2OpsStart: { type: 'String!', value: cycleStart(cfg) },
        r2OpsEnd: { type: 'String!', value: utcNow() },
        r2StorageStart: { type: 'String!', value: utcHoursAgo(STORAGE_WINDOW_HOURS) },
        r2StorageEnd: { type: 'String!', value: utcNow() },
      },
    };
  },

  parse(account: AccountData): MetricSample[] {
    const { r2OperationsAdaptiveGroups, r2StorageAdaptiveGroups } = account as R2Account;
    const opsRows = r2OperationsAdaptiveGroups ?? [];
    let classAOps = 0;
    let classBOps = 0;
    for (const row of opsRows) {
      const t = row.dimensions.actionType;
      if (CLASS_A_OPS.has(t)) classAOps += row.sum.requests;
      else if (CLASS_B_OPS.has(t)) classBOps += row.sum.requests;
      else if (FREE_OPS.has(t)) continue;
      else {
        // Fail safe: an unrecognised operation is billed as the more expensive,
        // smaller-quota class so a new name can only over-count, never hide spend.
        classAOps += row.sum.requests;
        console.warn(
          `r2: unclassified actionType "${t}" (${row.sum.requests} requests) counted as Class A`,
        );
      }
    }

    const storageBytes = sumPerEntityMax(
      'r2',
      'r2StorageAdaptiveGroups.max.payloadSize',
      r2StorageAdaptiveGroups ?? [],
      (r) => r.dimensions.bucketName,
      (r) => r.max.payloadSize,
      opsRows.length > 0,
    );

    return [
      { metric: 'storageBytes', value: storageBytes, window: 'cycle' },
      { metric: 'classAOps', value: classAOps, window: 'cycle' },
      { metric: 'classBOps', value: classBOps, window: 'cycle' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('r2', s, cfg.limits.r2[s.metric as keyof typeof cfg.limits.r2]),
    );
  },
};
