import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";

/**
 * Default maximum history turns.  30 is generous enough for long-running
 * conversations while preventing unbounded context growth that leads to
 * compaction storms or token-limit errors.
 */
export const DEFAULT_MAX_HISTORY_TURNS = 30;

/**
 * Read `agents.defaults.maxHistoryTurns` from config, falling back to
 * {@link DEFAULT_MAX_HISTORY_TURNS} when unset.
 *
 * Returns `undefined` when the feature is explicitly disabled (set to 0 or
 * a negative number).
 */
export function resolveMaxHistoryTurns(config?: OpenClawConfig): number | undefined {
  const raw = (config?.agents?.defaults as Record<string, unknown> | undefined)?.maxHistoryTurns;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const value = Math.floor(raw);
    // 0 or negative disables the limit.
    return value > 0 ? value : undefined;
  }

  return DEFAULT_MAX_HISTORY_TURNS;
}

export type HistoryTurnLimitResult = {
  /** Messages after trimming (may be the same reference when no trim occurred). */
  trimmedMessages: AgentMessage[];
  /** Number of user turns that were dropped. */
  droppedTurns: number;
};

/**
 * Keep only the most recent `maxTurns` user/assistant turn pairs while
 * **always preserving the first turn** (which typically establishes
 * conversational context or a system-injected preamble).
 *
 * A "turn" is defined as a user message and all subsequent non-user
 * messages (assistant replies, tool calls, tool results) until the next
 * user message.
 *
 * When `maxTurns` is `undefined`, `0`, or negative the input is returned
 * unchanged (no trimming).
 */
export function applyHistoryTurnLimit(
  messages: AgentMessage[],
  maxTurns: number | undefined,
): HistoryTurnLimitResult {
  if (!maxTurns || maxTurns <= 0 || messages.length === 0) {
    return { trimmedMessages: messages, droppedTurns: 0 };
  }

  // Identify turn boundaries (indices of user messages).
  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      turnStarts.push(i);
    }
  }

  // If total user turns fit within the limit, nothing to drop.
  if (turnStarts.length <= maxTurns) {
    return { trimmedMessages: messages, droppedTurns: 0 };
  }

  // We want to keep:
  //   1. The first turn (index 0 through turnStarts[1] - 1, or through end
  //      if there's only one turn).
  //   2. The last `maxTurns - 1` turns (so that together with the first
  //      turn we have `maxTurns` preserved turns, or `maxTurns` if the
  //      first turn is already in the kept range).

  const keepFromIndex = turnStarts.length - (maxTurns - 1);

  // Edge case: if keepFromIndex <= 1 the first turn is already within the
  // recent window -- just keep the last maxTurns turns.
  if (keepFromIndex <= 1) {
    const cutIndex = turnStarts.length - maxTurns;
    const sliceStart = turnStarts[cutIndex];
    return {
      trimmedMessages: messages.slice(sliceStart),
      droppedTurns: cutIndex,
    };
  }

  // Build the preserved slice: first turn + last (maxTurns - 1) turns.
  const firstTurnEnd = turnStarts[1]; // start of the second turn
  const recentStart = turnStarts[keepFromIndex];
  const droppedTurns = keepFromIndex - 1; // turns between first and kept range

  const trimmed = [
    ...messages.slice(0, firstTurnEnd),
    ...messages.slice(recentStart),
  ];

  return { trimmedMessages: trimmed, droppedTurns };
}
