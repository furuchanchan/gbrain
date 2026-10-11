/**
 * #6486: resolve the cross-modal eval's three judge slots at run time
 * from the provider recipes and the credentials actually present,
 * instead of static model ids that decay as providers ship new tiers.
 *
 * Each slot lands on a DISTINCT provider family (the frontier-only,
 * different-providers rule — correlated blind spots defeat the gate),
 * picked from a curated preference order of hosted chat providers.
 * Local/CLI transports (ollama, claude-cli, llama-server, lmstudio) are
 * not judge families. Explicit `--slot-a/b/c-model` flags always win
 * and reserve their provider; when fewer than three healthy families
 * remain the resolution fails closed so the caller reports what is
 * missing instead of silently judging with unconfigured defaults.
 */
import { RECIPES } from '../ai/recipes/index.ts';
import { mergedProviderEnv } from '../ai/provider-env.ts';
import { providerKeyReady } from '../model-config.ts';
import { latestOpenAITiers } from '../ai/openai-latest.ts';
import { loadConfig } from '../config.ts';
import { splitProviderModelId } from '../model-id.ts';
import type { SlotConfig } from './runner.ts';

export const EVAL_SLOT_IDS = ['A', 'B', 'C'] as const;

/** Hosted chat providers in eval preference order. */
export const EVAL_FAMILY_ORDER: readonly string[] = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'openrouter',
  'groq',
  'together',
  'mistral',
  'nvidia',
  'moonshot',
  'zhipu',
  'minimax',
  'dashscope',
  'azure-openai',
  'perplexity',
];

/**
 * The family's strongest listed chat model, resolved at run time.
 * OpenAI goes through the account-discovered deep tier (recipe list is
 * explicitly unordered); DeepSeek's list runs newest/strongest last;
 * the other recipes list their primary chat model first.
 */
export function evalFamilyChatModel(provider: string): string | null {
  const models = RECIPES.get(provider)?.touchpoints.chat?.models;
  if (!models?.length) return null;
  if (provider === 'openai') {
    const pick = latestOpenAITiers('deep');
    const discovered = typeof pick === 'string' ? pick : pick?.deep;
    return discovered ?? `openai:${models[0]}`;
  }
  if (provider === 'deepseek') return `deepseek:${models[models.length - 1]}`;
  return `${provider}:${models[0]}`;
}

/** The family is servable for eval judging: chat recipe + every required key present. */
function familyReady(provider: string, env: Record<string, string>): boolean {
  const model = evalFamilyChatModel(provider);
  return model !== null && providerKeyReady(model, env);
}

export interface EvalSlotResolutionOk {
  ok: true;
  slots: SlotConfig[];
}
export interface EvalSlotResolutionMissing {
  ok: false;
  /** Families that ARE servable — the message names them so the report is actionable. */
  ready: string[];
  needed: number;
}
export type EvalSlotResolution = EvalSlotResolutionOk | EvalSlotResolutionMissing;

/** Throw-safe config read: an unreadable config merges as env-only. */
function configOrNull() {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/**
 * Resolve slot A/B/C models. `explicit` is the parsed `--slot-*-model`
 * map. `opts.env` makes the resolution hermetic (used exclusively, no
 * config/process.env read); `opts.ready` overrides the readiness probe
 * entirely (the CLI passes an isAvailable-based check so the configured
 * gateway's own env — e.g. the autopilot daemon's — is honored).
 */
export function resolveEvalSlots(
  explicit: Record<string, string | undefined>,
  opts?: {
    env?: Record<string, string | undefined>;
    ready?: (provider: string) => boolean;
  },
): EvalSlotResolution {
  const merged = opts?.env
    ? (Object.fromEntries(
        Object.entries(opts.env).filter(([, v]) => v !== undefined && v !== ''),
      ) as Record<string, string>)
    : mergedProviderEnv(configOrNull(), process.env);
  const ready = opts?.ready ?? ((provider: string) => familyReady(provider, merged));

  const used = new Set<string>();
  const slots: SlotConfig[] = [];
  let unresolved = 0;
  for (const id of EVAL_SLOT_IDS) {
    const pinned = explicit[id]?.trim();
    if (pinned) {
      slots.push({ id, model: pinned });
      used.add(splitProviderModelId(pinned).provider ?? '');
      continue;
    }
    const family = EVAL_FAMILY_ORDER.find(p => !used.has(p) && ready(p));
    if (!family) {
      unresolved++;
      continue;
    }
    used.add(family);
    slots.push({ id, model: evalFamilyChatModel(family)! });
  }
  if (unresolved > 0) {
    return {
      ok: false,
      ready: EVAL_FAMILY_ORDER.filter(p => ready(p)),
      needed: EVAL_SLOT_IDS.length,
    };
  }
  return { ok: true, slots };
}
