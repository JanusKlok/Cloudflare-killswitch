import type { AppConfig, Env } from '../types.js';
import { CfApiError, cfFetch } from '../util/cf-api.js';

interface Ruleset {
  id: string;
  phase: string;
  rules?: { id: string; description?: string }[];
}

interface RuleResponse {
  id: string;
}

const PHASE = 'http_request_firewall_custom';

/** Identifies our rule inside a ruleset the operator also manages by hand.
 *  Used to reconcile after a failed create, so keep it stable across releases. */
const RULE_DESCRIPTION = 'Kill Switch — automated traffic block';

function scopeBase(env: Env, cfg: AppConfig): string {
  return cfg.scope === 'account'
    ? `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`
    : `/zones/${encodeURIComponent(env.CLOUDFLARE_ZONE_ID)}`;
}

function blockExpression(cfg: AppConfig, selfHostname?: string): string {
  // Exempt POST /restore so the recovery webhook stays reachable after a kill.
  // Scoped to the Worker's own hostname where we know it: a bare path match
  // would leave POST /restore reachable on every host in the zone, including
  // the operator's origin app.
  if (cfg.enableRecoveryWebhook) {
    const restore = 'http.request.method eq "POST" and http.request.uri.path eq "/restore"';
    return selfHostname
      ? `not (${restore} and http.host eq "${selfHostname}")`
      : `not (${restore})`;
  }
  // The rules language has no bare boolean literal; this field comparison is
  // the conventional match-all expression.
  return '(ip.src ne 0.0.0.0)';
}

function blockRule(cfg: AppConfig, selfHostname?: string) {
  return {
    expression: blockExpression(cfg, selfHostname),
    action: 'block',
    description: RULE_DESCRIPTION,
    enabled: true,
  };
}

/** Looks for a rule we previously created in this ruleset.  Called only to
 *  recover from a create whose response was lost: without it the rule would be
 *  live but unrecorded, so no restore could ever remove it. */
async function findOurRuleId(
  env: Env,
  base: string,
  rulesetId: string,
): Promise<string | undefined> {
  const rs = await cfFetch<Ruleset>(env.CLOUDFLARE_API_TOKEN, `${base}/rulesets/${rulesetId}`);
  return rs.rules?.find((r) => r.description === RULE_DESCRIPTION)?.id;
}

export async function deployBlockRule(
  env: Env,
  cfg: AppConfig,
  selfHostname?: string,
): Promise<{ ruleId: string; rulesetId: string }> {
  const base = scopeBase(env, cfg);
  const token = env.CLOUDFLARE_API_TOKEN;

  let rulesetId: string | undefined;
  try {
    const rs = await cfFetch<Ruleset>(token, `${base}/rulesets/phases/${PHASE}/entrypoint`);
    rulesetId = rs.id;
  } catch (err) {
    // PUT on a phase entrypoint REPLACES its entire rules array, so the create
    // path below may only run when the ruleset genuinely does not exist yet.
    // Treating any failure as "missing" would let an expired token, a rate
    // limit or a 502 wipe every custom rule the operator has.
    if (!(err instanceof CfApiError) || !err.isNotFound) throw err;
  }

  if (rulesetId === undefined) {
    // No entrypoint for this phase yet — create it carrying our rule. PUT with
    // a fixed body is idempotent, so a retry is safe here.
    const created = await cfFetch<Ruleset>(
      token,
      `${base}/rulesets/phases/${PHASE}/entrypoint`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: 'Kill Switch Custom Rules',
          description: 'Managed by cloudflare-killswitch',
          rules: [blockRule(cfg, selfHostname)],
        }),
      },
    );
    const rule = created.rules?.[0];
    if (!rule) throw new Error('WAF rule creation returned no rule ID');
    return { ruleId: rule.id, rulesetId: created.id };
  }

  // Ruleset exists — append our rule. Not retried: a retry after a create that
  // actually succeeded would add a second rule and record only the second id,
  // orphaning the first with no way for /restore to remove it.
  try {
    const added = await cfFetch<RuleResponse>(token, `${base}/rulesets/${rulesetId}/rules`, {
      method: 'POST',
      retry: false,
      body: JSON.stringify(blockRule(cfg, selfHostname)),
    });
    return { ruleId: added.id, rulesetId };
  } catch (err) {
    // The rule may have been created before the response was lost. Adopt it if
    // so, otherwise the block would be live and permanently unremovable.
    const adopted = await findOurRuleId(env, base, rulesetId).catch(() => undefined);
    if (adopted) {
      console.warn(`waf: rule create reported failure but rule ${adopted} exists — adopting it`);
      return { ruleId: adopted, rulesetId };
    }
    throw err;
  }
}

export async function removeBlockRule(
  env: Env,
  cfg: AppConfig,
  ruleId: string,
  rulesetId: string,
): Promise<void> {
  const base = scopeBase(env, cfg);
  try {
    await cfFetch<unknown>(env.CLOUDFLARE_API_TOKEN, `${base}/rulesets/${rulesetId}/rules/${encodeURIComponent(ruleId)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    // Already gone — the desired end state, so report success.  Matched on the
    // structured status/codes rather than a substring of the message, which
    // also matched a rule id or timestamp that merely contained "404".
    if (err instanceof CfApiError && (err.isNotFound || err.codes.includes(10005))) return;
    throw err;
  }
}
