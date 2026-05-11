import type { D1PurgeTarget, Env } from '../types.js';

const PLACEHOLDER_RE = /^REPLACE_ME/i;

export interface D1PurgeResult {
  bindingName: string;
  tableResults: { table: string; action: string; success: boolean; error?: string }[];
}

export async function purgeD1(env: Env, target: D1PurgeTarget): Promise<D1PurgeResult> {
  if (PLACEHOLDER_RE.test(target.bindingName)) {
    throw new Error(
      `D1 purge config still has placeholder binding name "${target.bindingName}" — update config.ts`,
    );
  }

  const db = (env as unknown as Record<string, D1Database | undefined>)[target.bindingName];
  if (!db) {
    throw new Error(
      `D1 binding "${target.bindingName}" not found on env — add it to wrangler.toml and redeploy`,
    );
  }

  const result: D1PurgeResult = { bindingName: target.bindingName, tableResults: [] };

  for (const tbl of target.tables) {
    const sql =
      tbl.action === 'DROP' ? `DROP TABLE IF EXISTS \`${tbl.name}\`` : `DELETE FROM \`${tbl.name}\``;
    try {
      await db.prepare(sql).run();
      result.tableResults.push({ table: tbl.name, action: tbl.action, success: true });
    } catch (err) {
      result.tableResults.push({
        table: tbl.name,
        action: tbl.action,
        success: false,
        error: String(err),
      });
    }
  }

  return result;
}
