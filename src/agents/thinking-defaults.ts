import type { OpenClawConfig } from "../config/config.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";

/**
 * Intent complexity hint that can be provided by an upstream classifier.
 * Used to adjust the default thinking level on a per-request basis.
 */
export type IntentComplexity = "simple" | "moderate" | "complex";

/**
 * Token cost trade-offs for each thinking level:
 *
 * - "off"     :    0 extra tokens  -- no chain-of-thought; fastest, cheapest.
 * - "minimal" :  ~200-500 tokens   -- very brief internal reasoning; good for
 *                                     short factual lookups and trivial tasks.
 * - "low"     :  ~500-2 000 tokens -- lightweight reasoning; solid default for
 *                                     most conversational and coding tasks.
 * - "medium"  : ~2 000-8 000 tokens -- moderate reasoning; multi-step analysis,
 *                                      refactoring, debugging.
 * - "high"    : ~8 000-32 000 tokens -- deep reasoning; complex architecture
 *                                       decisions, long proofs, multi-file diffs.
 * - "xhigh"   : ~32 000-100 000+ tokens -- exhaustive reasoning; reserved for
 *                                          very hard problems on supported models.
 *
 * The default level ("low") balances quality and cost for the majority of
 * real-world interactions. Callers should only escalate when the task
 * genuinely benefits from deeper reasoning.
 */
const DEFAULT_THINKING_LEVEL: ThinkLevel = "low";

/**
 * Resolve the default thinking level from config, with an optional
 * intent-based adjustment.
 *
 * Resolution order:
 *   1. `agents.defaults.thinkingDefault` in config (explicit override).
 *   2. Intent-based adjustment (when `intent` is provided).
 *   3. Hardcoded default: "low".
 *
 * When config specifies a level it takes precedence over intent-based
 * adjustment -- the config value represents an explicit operator choice.
 */
export function resolveDefaultThinkingLevel(
  config?: OpenClawConfig,
  intent?: IntentComplexity,
): ThinkLevel {
  // Honour explicit config override.
  const configured = config?.agents?.defaults?.thinkingDefault;
  if (configured) {
    return configured;
  }

  // If no config override, adjust based on intent when available.
  if (intent) {
    return thinkingLevelForIntent(intent);
  }

  return DEFAULT_THINKING_LEVEL;
}

/**
 * Map an intent complexity classification to a sensible thinking level.
 *
 * The mapping is intentionally conservative -- "simple" still gets
 * "minimal" (not "off") so the model retains a small reasoning budget
 * for edge cases that look simple but aren't.
 */
function thinkingLevelForIntent(intent: IntentComplexity): ThinkLevel {
  switch (intent) {
    case "simple":
      return "minimal";
    case "moderate":
      return "low";
    case "complex":
      return "medium";
    default:
      return DEFAULT_THINKING_LEVEL;
  }
}
