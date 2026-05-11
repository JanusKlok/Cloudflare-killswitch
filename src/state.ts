import type { Env, KvState } from './types.js';

const KV_KEY = 'state';

const ACTIVE: KvState = { status: 'active', timestamp: new Date().toISOString() };

export async function readState(env: Env): Promise<KvState> {
  const raw = await env.KILL_SWITCH_STATE.get(KV_KEY);
  if (!raw) return ACTIVE;
  try {
    return JSON.parse(raw) as KvState;
  } catch {
    return ACTIVE;
  }
}

export async function writeKilled(
  env: Env,
  opts: {
    reason: string;
    wafRuleId: string;
    wafRulesetId: string;
    disabledWorkerScripts?: string[];
    blockedPagesProjects?: KvState['blockedPagesProjects'];
  },
): Promise<void> {
  const state: KvState = {
    status: 'killed',
    timestamp: new Date().toISOString(),
    reason: opts.reason,
    wafRuleId: opts.wafRuleId,
    wafRulesetId: opts.wafRulesetId,
  };
  if (opts.disabledWorkerScripts?.length) state.disabledWorkerScripts = opts.disabledWorkerScripts;
  if (opts.blockedPagesProjects?.length) state.blockedPagesProjects = opts.blockedPagesProjects;
  await env.KILL_SWITCH_STATE.put(KV_KEY, JSON.stringify(state));
}

export async function writeActive(env: Env): Promise<void> {
  const state: KvState = { status: 'active', timestamp: new Date().toISOString() };
  await env.KILL_SWITCH_STATE.put(KV_KEY, JSON.stringify(state));
}

export function shouldAutoReset(state: KvState, autoResetEnabled: boolean): boolean {
  if (!autoResetEnabled) return false;
  if (state.status !== 'killed') return false;

  const now = new Date();
  if (now.getUTCDate() !== 1) return false;

  const killedAt = new Date(state.timestamp);
  if (
    killedAt.getUTCFullYear() === now.getUTCFullYear() &&
    killedAt.getUTCMonth() === now.getUTCMonth()
  ) {
    // Already reset this month
    return false;
  }

  return true;
}
