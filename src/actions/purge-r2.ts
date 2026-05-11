import type { Env, R2PurgeTarget } from '../types.js';

const PLACEHOLDER_RE = /^REPLACE_ME/i;

export interface PurgeResult {
  bindingName: string;
  deleted: number;
  errors: string[];
}

export async function purgeR2(env: Env, target: R2PurgeTarget): Promise<PurgeResult> {
  if (PLACEHOLDER_RE.test(target.bindingName)) {
    throw new Error(
      `R2 purge config still has placeholder binding name "${target.bindingName}" — update config.ts`,
    );
  }

  const bucket = (env as unknown as Record<string, R2Bucket | undefined>)[target.bindingName];
  if (!bucket) {
    throw new Error(
      `R2 binding "${target.bindingName}" not found on env — add it to wrangler.toml and redeploy`,
    );
  }

  const prefixes = target.prefixes.length > 0 ? target.prefixes : [undefined];
  const result: PurgeResult = { bindingName: target.bindingName, deleted: 0, errors: [] };

  for (const prefix of prefixes) {
    try {
      await purgePrefix(bucket, prefix, target.deleteOrder, result);
    } catch (err) {
      result.errors.push(`prefix "${prefix ?? '(root)'}": ${String(err)}`);
    }
  }

  return result;
}

async function purgePrefix(
  bucket: R2Bucket,
  prefix: string | undefined,
  order: 'newest' | 'oldest',
  result: PurgeResult,
): Promise<void> {
  let cursor: string | undefined;

  // Collect all matching objects then sort before deleting.
  const objects: { key: string; uploaded: Date }[] = [];

  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      objects.push({ key: obj.key, uploaded: obj.uploaded });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  objects.sort((a, b) =>
    order === 'newest'
      ? b.uploaded.getTime() - a.uploaded.getTime()
      : a.uploaded.getTime() - b.uploaded.getTime(),
  );

  // Delete in batches of 1000 (R2 deleteMultiple limit).
  const BATCH = 1000;
  for (let i = 0; i < objects.length; i += BATCH) {
    const keys = objects.slice(i, i + BATCH).map((o) => o.key);
    await bucket.delete(keys);
    result.deleted += keys.length;
  }
}
