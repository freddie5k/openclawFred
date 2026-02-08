import type { NormalizedUsage } from "./usage.js";

/**
 * Budget check result from the cost governor.
 * - allowed: true if the session may proceed with another attempt.
 * - remaining: tokens left before the budget is exhausted (Infinity when unlimited).
 * - suggestion: optional hint for the caller (e.g., switch model, reduce thinking).
 */
export type BudgetCheckResult = {
  allowed: boolean;
  remaining: number;
  suggestion?: string;
};

/** Warn threshold: suggest cheaper model when 80% of budget is consumed. */
const WARN_RATIO = 0.8;
/** Hard-stop threshold: block when 100% of budget is consumed. */
const STOP_RATIO = 1.0;

/**
 * Tracks cumulative token usage within a single session run and enforces
 * an optional token budget.
 *
 * Budget of 0 (the default) means unlimited -- no enforcement.
 */
export class CostGovernor {
  private cumulativeInput = 0;
  private cumulativeOutput = 0;
  private cumulativeThinking = 0;
  private readonly budget: number;

  constructor(budget = 0) {
    // Treat negative or non-finite values as unlimited.
    this.budget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  }

  /** Whether this governor enforces a budget (budget > 0). */
  get isEnforcing(): boolean {
    return this.budget > 0;
  }

  /** Total token budget (0 = unlimited). */
  get tokenBudget(): number {
    return this.budget;
  }

  /** Current cumulative token totals. */
  get totals(): { input: number; output: number; thinking: number; total: number } {
    return {
      input: this.cumulativeInput,
      output: this.cumulativeOutput,
      thinking: this.cumulativeThinking,
      total: this.cumulativeInput + this.cumulativeOutput + this.cumulativeThinking,
    };
  }

  /**
   * Record usage from a completed attempt.
   * `thinkingTokens` is optional; some providers report it separately.
   */
  recordUsage(usage: NormalizedUsage | undefined, thinkingTokens?: number): void {
    if (usage) {
      this.cumulativeInput += usage.input ?? 0;
      this.cumulativeOutput += usage.output ?? 0;
    }
    if (typeof thinkingTokens === "number" && Number.isFinite(thinkingTokens)) {
      this.cumulativeThinking += thinkingTokens;
    }
  }

  /**
   * Check whether the session may proceed given the cumulative usage so far.
   * Call this *before* each new attempt in the run loop.
   *
   * @param pendingEstimate - optional estimate of tokens the next attempt will
   *   consume. When provided the check uses (cumulative + pending) for the
   *   comparison.
   */
  checkBudget(pendingEstimate = 0): BudgetCheckResult {
    if (!this.isEnforcing) {
      return { allowed: true, remaining: Infinity };
    }

    const used = this.cumulativeInput + this.cumulativeOutput + this.cumulativeThinking;
    const projected = used + Math.max(0, pendingEstimate);
    const remaining = Math.max(0, this.budget - used);

    // Over budget (or would be with pending estimate).
    if (projected >= this.budget * STOP_RATIO) {
      return {
        allowed: remaining > 0,
        remaining,
        suggestion:
          remaining <= 0
            ? `Token budget exhausted (${used.toLocaleString()} / ${this.budget.toLocaleString()} tokens used). ` +
              "Start a new session or increase agents.defaults.tokenBudget."
            : `Approaching token budget limit (${used.toLocaleString()} / ${this.budget.toLocaleString()}). ` +
              "Consider wrapping up soon.",
      };
    }

    // Warning zone: suggest switching to a cheaper model or lowering thinking.
    if (used >= this.budget * WARN_RATIO) {
      return {
        allowed: true,
        remaining,
        suggestion:
          `${Math.round((used / this.budget) * 100)}% of token budget used ` +
          `(${used.toLocaleString()} / ${this.budget.toLocaleString()}). ` +
          "Consider switching to a cheaper model or lowering thinking level.",
      };
    }

    return { allowed: true, remaining };
  }
}

/**
 * Resolve the token budget from config, defaulting to 0 (unlimited).
 */
export function resolveTokenBudget(config?: { agents?: { defaults?: { tokenBudget?: number } } }): number {
  const raw = config?.agents?.defaults?.tokenBudget;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}
