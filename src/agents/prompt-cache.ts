import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";

/**
 * Prompt caching layer for Anthropic models.
 *
 * Anthropic's prompt caching allows cached input tokens to be billed at
 * ~10% of the standard rate. The SDK's `cacheRetention` stream option
 * handles the protocol details; this module decides *when* to enable it
 * and wraps the streamFn accordingly.
 *
 * Only applies when the provider is "anthropic". Other providers are
 * passed through unmodified.
 *
 * Config path: `agents.defaults.promptCache`
 *   - `enabled` (boolean, default: true for Anthropic)
 *   - `retention` ("short" | "long", default: "short")
 *     "short" = 5 min TTL, "long" = 1 hour TTL
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptCacheConfig = {
  /** Enable automatic prompt caching (default: true for Anthropic). */
  enabled: boolean;
  /**
   * Cache retention level:
   * - "short": ~5 min TTL. Best for interactive sessions with rapid turns.
   * - "long":  ~1 hr TTL. Best for long-running or batch sessions.
   */
  retention: "short" | "long";
};

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION: PromptCacheConfig["retention"] = "short";

/**
 * Resolve prompt cache configuration from the OpenClaw config.
 * Returns `{ enabled: false }` for non-Anthropic providers.
 */
export function resolvePromptCacheConfig(
  config?: OpenClawConfig,
  provider?: string,
): PromptCacheConfig {
  // Only Anthropic supports cacheRetention today.
  if (provider && provider !== "anthropic") {
    return { enabled: false, retention: DEFAULT_RETENTION };
  }

  const defaults = config?.agents?.defaults as Record<string, unknown> | undefined;
  const raw = defaults?.promptCache;

  if (raw === false) {
    return { enabled: false, retention: DEFAULT_RETENTION };
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      enabled: obj.enabled !== false,
      retention:
        obj.retention === "short" || obj.retention === "long"
          ? obj.retention
          : DEFAULT_RETENTION,
    };
  }

  // Default: enabled for Anthropic.
  return { enabled: true, retention: DEFAULT_RETENTION };
}

// ---------------------------------------------------------------------------
// StreamFn wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a streamFn to automatically set `cacheRetention` on every call.
 *
 * When the provider is Anthropic and prompt caching is enabled, the SDK
 * will mark the system prompt and tool definitions as cacheable. On
 * subsequent turns the cached prefix is served at ~10% of input cost.
 *
 * Returns `undefined` when no wrapping is needed (not Anthropic, or
 * caching is disabled, or a cacheRetention is already set via extraParams).
 */
export function wrapStreamFnWithCaching(params: {
  baseStreamFn?: StreamFn;
  config?: OpenClawConfig;
  provider: string;
  /** When true, skip wrapping (the caller already set cacheRetention). */
  cacheRetentionAlreadySet?: boolean;
}): StreamFn | undefined {
  if (params.cacheRetentionAlreadySet) {
    return undefined;
  }

  const cacheConfig = resolvePromptCacheConfig(params.config, params.provider);
  if (!cacheConfig.enabled) {
    return undefined;
  }

  const underlying = params.baseStreamFn ?? streamSimple;
  const retention = cacheConfig.retention;

  const wrappedStreamFn: StreamFn = (model, context, options) => {
    const opts: Partial<SimpleStreamOptions> & { cacheRetention?: string } = {
      ...options,
    };
    // Only set if not already overridden by the caller.
    if (!opts.cacheRetention) {
      opts.cacheRetention = retention;
    }
    return underlying(model, context, opts);
  };

  return wrappedStreamFn;
}

// ---------------------------------------------------------------------------
// Estimation helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the per-turn savings from prompt caching.
 *
 * Cached input tokens cost ~10% of uncached. The savings apply to the
 * stable prefix (system prompt + tool definitions) which is identical
 * across turns.
 *
 * @param stablePrefixTokens - estimated tokens in the cacheable prefix
 * @param turns - number of conversation turns
 * @returns estimated tokens saved over the session
 */
export function estimateCacheSavings(stablePrefixTokens: number, turns: number): number {
  if (turns <= 1 || stablePrefixTokens <= 0) {
    return 0;
  }
  // First turn: full cost. Subsequent turns: 90% savings on the prefix.
  const savingsPerTurn = stablePrefixTokens * 0.9;
  return Math.floor(savingsPerTurn * (turns - 1));
}
