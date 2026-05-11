import type { AppConfig, Breach, Env, MetricSample, ServiceModule } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcMonthStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

// R2 operation classification.
// Class A: mutating operations that cost more per million.
// Class B: read / metadata operations.
// Source: https://developers.cloudflare.com/r2/pricing/
const CLASS_A_OPS = new Set([
  'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'UploadPart', 'UploadPartCopy', 'DeleteObject', 'DeleteObjects',
  'AbortMultipartUpload', 'CreateBucket', 'DeleteBucket',
  'PutBucketCors', 'DeleteBucketCors', 'PutBucketLifecycleConfiguration',
  'DeleteBucketLifecycleConfiguration',
]);

const CLASS_B_OPS = new Set([
  'GetObject', 'HeadObject', 'ListObjects', 'ListObjectsV2',
  'HeadBucket', 'ListBuckets', 'ListMultipartUploads', 'ListParts',
  'GetBucketCors', 'GetBucketLocation', 'GetBucketLifecycleConfiguration',
]);

interface R2OpsData {
  viewer: {
    accounts: {
      r2OperationsAdaptiveGroups: {
        sum: { requests: number };
        dimensions: { actionType: string };
      }[];
    }[];
  };
}

interface R2StorageData {
  viewer: {
    accounts: {
      r2StorageAdaptiveGroups: { max: { payloadSize: number } }[];
    }[];
  };
}

export const r2Module: ServiceModule = {
  name: 'r2',

  async fetchUsage(env: Env, _cfg: AppConfig): Promise<MetricSample[]> {
    const [opsData, storageData] = await Promise.all([
      gql<R2OpsData>(
        env,
        `query R2Ops($accountTag: String!, $start: String!, $end: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              r2OperationsAdaptiveGroups(
                limit: 10000
                filter: { datetime_geq: $start, datetime_leq: $end }
              ) {
                sum { requests }
                dimensions { actionType }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcMonthStart(), end: utcNow() },
      ),
      gql<R2StorageData>(
        env,
        `query R2Storage($accountTag: String!, $start: String!, $end: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              r2StorageAdaptiveGroups(
                limit: 10000
                filter: { datetime_geq: $start, datetime_leq: $end }
              ) {
                max { payloadSize }
              }
            }
          }
        }`,
        { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: utcMonthStart(), end: utcNow() },
      ),
    ]);

    const opsRows = opsData.viewer.accounts[0]?.r2OperationsAdaptiveGroups ?? [];
    let classAOps = 0;
    let classBOps = 0;
    for (const row of opsRows) {
      const t = row.dimensions.actionType;
      if (CLASS_A_OPS.has(t)) classAOps += row.sum.requests;
      else if (CLASS_B_OPS.has(t)) classBOps += row.sum.requests;
    }

    const storageRows = storageData.viewer.accounts[0]?.r2StorageAdaptiveGroups ?? [];
    const storageBytes = storageRows.reduce((max, r) => Math.max(max, r.max.payloadSize), 0);

    return [
      { metric: 'storageBytes', value: storageBytes, window: 'month' },
      { metric: 'classAOps', value: classAOps, window: 'month' },
      { metric: 'classBOps', value: classBOps, window: 'month' },
    ];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('r2', s, cfg.limits.r2[s.metric as keyof typeof cfg.limits.r2]),
    );
  },
};
