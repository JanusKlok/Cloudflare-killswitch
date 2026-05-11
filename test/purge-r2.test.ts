import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { purgeR2 } from '../src/actions/purge-r2.js';
import type { R2PurgeTarget } from '../src/types.js';

function makeR2Object(key: string, uploaded: Date): R2Object {
  return { key, uploaded, size: 100, etag: 'abc', httpEtag: '"abc"', checksums: { md5: undefined, sha1: undefined, sha256: undefined, sha512: undefined, toJSON: () => ({}) }, version: '1', storageClass: 'Standard', writeHttpMetadata: () => {}, httpMetadata: undefined, customMetadata: undefined } as unknown as R2Object;
}

describe('purgeR2', () => {
  it('throws on placeholder binding name', async () => {
    const target: R2PurgeTarget = {
      bindingName: 'REPLACE_ME_R2_BINDING',
      prefixes: [],
      deleteOrder: 'newest',
    };
    await expect(purgeR2(env, target)).rejects.toThrow('placeholder');
  });

  it('throws when binding is missing from env', async () => {
    const target: R2PurgeTarget = {
      bindingName: 'NONEXISTENT_BUCKET',
      prefixes: [],
      deleteOrder: 'newest',
    };
    await expect(purgeR2(env, target)).rejects.toThrow('not found on env');
  });

  it('deletes all objects from a bound bucket newest-first', async () => {
    const deleted: string[] = [];
    const now = Date.now();
    const mockBucket: Partial<R2Bucket> = {
      list: vi.fn().mockResolvedValue({
        objects: [
          makeR2Object('file-old.txt', new Date(now - 3000)),
          makeR2Object('file-new.txt', new Date(now - 1000)),
          makeR2Object('file-mid.txt', new Date(now - 2000)),
        ],
        truncated: false,
        cursor: '',
        delimitedPrefixes: [],
      }),
      delete: vi.fn().mockImplementation(async (keys: string[]) => {
        deleted.push(...keys);
      }),
    };

    const envWithBucket = { ...env, MY_TEST_BUCKET: mockBucket };
    const target: R2PurgeTarget = {
      bindingName: 'MY_TEST_BUCKET',
      prefixes: [],
      deleteOrder: 'newest',
    };

    const result = await purgeR2(envWithBucket as typeof env, target);
    expect(result.deleted).toBe(3);
    expect(result.errors).toHaveLength(0);
    // Newest first
    expect(deleted[0]).toBe('file-new.txt');
    expect(deleted[1]).toBe('file-mid.txt');
    expect(deleted[2]).toBe('file-old.txt');
  });
});
