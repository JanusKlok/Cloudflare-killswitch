import type { AppConfig, Env } from '../types.js';
import { fetchRetry } from '../util/retry.js';

const CF = 'https://api.cloudflare.com/client/v4';

interface CfApiResult<T> {
  result: T;
  success: boolean;
  errors: { code: number; message: string }[];
}

interface Ruleset {
  id: string;
  phase: string;
  rules: { id: string }[];
}

interface RuleResponse {
  id: string;
}

async function cfFetch<T>(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchRetry(`${CF}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const body = (await res.json()) as CfApiResult<T>;

  if (!body.success) {
    const msg = body.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cloudflare API error (${res.status}): ${msg}`);
  }

  return body.result;
}

function scopeBase(env: Env, cfg: AppConfig): string {
  return cfg.scope === 'account'
    ? `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`
    : `/zones/${env.CLOUDFLARE_ZONE_ID}`;
}

function blockExpression(cfg: AppConfig): string {
  // Exempt POST /restore so the recovery webhook remains reachable after a kill.
  if (cfg.enableRecoveryWebhook) {
    return 'not (http.request.method eq "POST" and http.request.uri.path eq "/restore")';
  }
  return '(true)';
}

export async function deployBlockRule(
  env: Env,
  cfg: AppConfig,
): Promise<{ ruleId: string; rulesetId: string }> {
  const base = scopeBase(env, cfg);
  const phase = 'http_request_firewall_custom';

  // Try to fetch the entrypoint ruleset for this phase.
  let rulesetId: string;
  try {
    const rs = await cfFetch<Ruleset>(env, `${base}/rulesets/phases/${phase}/entrypoint`);
    rulesetId = rs.id;
  } catch {
    // Entrypoint doesn't exist yet — create it with our rule directly via PUT.
    const created = await cfFetch<Ruleset>(
      env,
      `${base}/rulesets/phases/${phase}/entrypoint`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: 'Kill Switch Custom Rules',
          description: 'Managed by cloudflare-killswitch',
          rules: [
            {
              expression: blockExpression(cfg),
              action: 'block',
              description: 'Kill Switch — automated traffic block',
              enabled: true,
            },
          ],
        }),
      },
    );
    const rule = created.rules[0];
    if (!rule) throw new Error('WAF rule creation returned no rule ID');
    return { ruleId: rule.id, rulesetId: created.id };
  }

  // Ruleset exists — append our rule.
  const added = await cfFetch<RuleResponse>(
    env,
    `${base}/rulesets/${rulesetId}/rules`,
    {
      method: 'POST',
      body: JSON.stringify({
        expression: blockExpression(cfg),
        action: 'block',
        description: 'Kill Switch — automated traffic block',
        enabled: true,
      }),
    },
  );

  return { ruleId: added.id, rulesetId };
}

export async function removeBlockRule(
  env: Env,
  cfg: AppConfig,
  ruleId: string,
  rulesetId: string,
): Promise<void> {
  const base = scopeBase(env, cfg);
  try {
    await cfFetch<unknown>(
      env,
      `${base}/rulesets/${rulesetId}/rules/${ruleId}`,
      { method: 'DELETE' },
    );
  } catch (err) {
    // 404 means the rule was already removed — treat as success.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('10005') && !msg.includes('404')) throw err;
  }
}
