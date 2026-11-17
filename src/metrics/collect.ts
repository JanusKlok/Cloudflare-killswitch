import type {
  AccountData,
  AppConfig,
  Env,
  MetricSample,
  ServiceModule,
  UsageQuery,
} from '../types.js';
import { gqlRaw, type GqlError } from '../graphql/client.js';

export type ModuleOutcome = { samples: MetricSample[] } | { error: string };

/** Merged attempts before giving up on merging.  The retry exists for the case
 *  where one dataset's error nulls the whole `data`: drop the blamed module and
 *  ask again for the rest, rather than paying one request per module. */
const MAX_MERGED_ROUNDS = 2;

interface Pending {
  index: number;
  mod: ServiceModule;
  query: UsageQuery;
}

interface GqlData {
  viewer?: { accounts?: AccountData[] | null } | null;
}

/** One request for every module's datasets.  Subrequests are the scarce
 *  resource (Workers Free allows 50 per invocation), and the old layout spent
 *  8 on GraphQL alone.  The merged query is built from each module's own
 *  selection, so adding a service stays one module plus one registry line.
 *
 *  Isolation is preserved: one failing dataset must not read as "all metrics
 *  failed".  Cloudflare reports each error with a `path` from the root, e.g.
 *  ["viewer","accounts",0,"kvStorageAdaptiveGroups"]
 *  (https://developers.cloudflare.com/analytics/graphql-api/errors/), so the
 *  segment after the account index names the dataset and therefore the module.
 *  Only blamed modules fail; the rest parse from the same response when it still
 *  carries `data`, or from a re-request without the blamed modules when it does
 *  not (Cloudflare's own example error has `data: null`).  Errors that cannot be
 *  attributed fall back to one request per module, i.e. the previous behaviour. */
export async function collectUsage(
  env: Env,
  cfg: AppConfig,
  modules: ServiceModule[],
): Promise<ModuleOutcome[]> {
  const outcomes: ModuleOutcome[] = Array.from({ length: modules.length });
  let pending: Pending[] = [];
  modules.forEach((mod, index) => {
    try {
      pending.push({ index, mod, query: mod.query(cfg) });
    } catch (err) {
      outcomes[index] = { error: String(err) };
    }
  });

  for (let round = 0; round < MAX_MERGED_ROUNDS && pending.length > 0; round++) {
    let result;
    try {
      const [query, variables] = build(env, pending);
      result = await gqlRaw<GqlData>(env, query, variables);
    } catch (err) {
      // No GraphQL answer at all (auth, rate limit, outage): per-module requests
      // would only repeat it and burn subrequests.
      for (const p of pending) outcomes[p.index] = { error: String(err) };
      return outcomes;
    }

    const account = accountOf(result.data);
    if (result.errors.length === 0) {
      for (const p of pending) outcomes[p.index] = parseSlice(p.mod, account ?? {});
      return outcomes;
    }

    const blamed = attribute(result.errors, pending);
    if (!blamed) break;
    for (const [p, messages] of blamed) {
      outcomes[p.index] = { error: `GraphQL errors: ${messages.join('; ')}` };
    }
    pending = pending.filter((p) => !blamed.has(p));
    if (account) {
      for (const p of pending) outcomes[p.index] = parseSlice(p.mod, account);
      return outcomes;
    }
  }

  await Promise.all(
    pending.map(async (p) => {
      outcomes[p.index] = await collectOne(env, p);
    }),
  );
  return outcomes;
}

/** Old-style isolated fetch for one module; any GraphQL error fails it. */
async function collectOne(env: Env, p: Pending): Promise<ModuleOutcome> {
  try {
    const [query, variables] = build(env, [p]);
    const { data, errors } = await gqlRaw<GqlData>(env, query, variables);
    if (errors.length > 0) {
      return { error: `GraphQL errors: ${errors.map((e) => e.message).join('; ')}` };
    }
    if (!data) return { error: 'GraphQL response contained no data' };
    return parseSlice(p.mod, accountOf(data) ?? {});
  } catch (err) {
    return { error: String(err) };
  }
}

/** Fetches one module alone; throws when its data cannot be trusted. */
export async function fetchModuleUsage(
  env: Env,
  cfg: AppConfig,
  mod: ServiceModule,
): Promise<MetricSample[]> {
  const [outcome] = await collectUsage(env, cfg, [mod]);
  if (!outcome) throw new Error('no outcome');
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome.samples;
}

function accountOf(data: GqlData | null): AccountData | undefined {
  return data?.viewer?.accounts?.[0] ?? undefined;
}

function parseSlice(mod: ServiceModule, account: AccountData): ModuleOutcome {
  try {
    return { samples: mod.parse(account) };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Exported for tests of the registry's uniqueness rules. */
export function build(
  env: Env,
  parts: Pick<Pending, 'mod' | 'query'>[],
): [string, Record<string, unknown>] {
  const declarations = ['$accountTag: String!'];
  const variables: Record<string, unknown> = { accountTag: env.CLOUDFLARE_ACCOUNT_ID };
  const keys = new Set<string>();
  for (const { mod, query } of parts) {
    for (const key of query.keys) {
      if (keys.has(key)) throw new Error(`${mod.name}: response key "${key}" is used twice`);
      keys.add(key);
    }
    for (const [name, v] of Object.entries(query.variables)) {
      if (name in variables) throw new Error(`${mod.name}: variable $${name} is used twice`);
      declarations.push(`$${name}: ${v.type}`);
      variables[name] = v.value;
    }
  }
  const selections = parts.map((p) => p.query.selection).join('\n');
  const text = `query Usage(${declarations.join(', ')}) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${selections}
    }
  }
}`;
  return [text, variables];
}

/** Maps each error to the module owning the dataset in its path.  Returns
 *  undefined when any error cannot be attributed, so the caller falls back. */
function attribute(errors: GqlError[], parts: Pending[]): Map<Pending, string[]> | undefined {
  const blamed = new Map<Pending, string[]>();
  for (const e of errors) {
    const path = e.path;
    const key = path?.[0] === 'viewer' && path[1] === 'accounts' ? path[3] : undefined;
    const owner =
      typeof key === 'string' ? parts.find((p) => p.query.keys.includes(key)) : undefined;
    if (!owner) return undefined;
    blamed.set(owner, [...(blamed.get(owner) ?? []), e.message]);
  }
  return blamed;
}
