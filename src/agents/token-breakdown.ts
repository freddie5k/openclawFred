import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

/**
 * Per-component token usage breakdown for a single agent turn.
 * All values are estimates based on character-to-token heuristics
 * (via pi-coding-agent's estimateTokens) unless actual usage data is provided.
 */
export type TokenBreakdown = {
  /** Tokens consumed by the system prompt. */
  systemPrompt: number;
  /** Tokens consumed by conversation history (prior messages). */
  history: number;
  /** Tokens consumed by tool definitions (schemas). */
  toolDefinitions: number;
  /** Tokens consumed by tool results in the current turn. */
  toolResults: number;
  /** Tokens consumed by extended thinking / reasoning. */
  thinking: number;
  /** Tokens consumed by the assistant's response. */
  response: number;
  /** Sum of all components. */
  total: number;
};

// Rough chars-per-token ratio for estimation from raw text.
const CHARS_PER_TOKEN = 4;

function estimateFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

function estimateFromMessages(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

/**
 * Estimate the token breakdown for a prompt turn.
 *
 * All fields are optional: when actual usage data is available (e.g., from
 * provider response headers) the caller can pass it directly in
 * `actualUsage` and the estimator will prefer those values.
 */
export function estimateTokenBreakdown(params: {
  /** Raw system prompt text (used for estimation). */
  systemPromptText?: string;
  /** Conversation history messages (excluding current user prompt). */
  historyMessages?: AgentMessage[];
  /** Total chars of tool definition schemas. */
  toolDefinitionChars?: number;
  /** Tool result messages from the current turn. */
  toolResultMessages?: AgentMessage[];
  /** Actual usage from the provider response. */
  actualUsage?: {
    input?: number;
    output?: number;
    thinkingTokens?: number;
  };
}): TokenBreakdown {
  const systemPrompt = params.systemPromptText
    ? estimateFromChars(params.systemPromptText.length)
    : 0;

  const history = params.historyMessages ? estimateFromMessages(params.historyMessages) : 0;

  const toolDefinitions =
    typeof params.toolDefinitionChars === "number"
      ? estimateFromChars(params.toolDefinitionChars)
      : 0;

  const toolResults = params.toolResultMessages
    ? estimateFromMessages(params.toolResultMessages)
    : 0;

  // Prefer actual usage when available.
  const thinking = params.actualUsage?.thinkingTokens ?? 0;
  const response = params.actualUsage?.output ?? 0;

  const total = systemPrompt + history + toolDefinitions + toolResults + thinking + response;

  return { systemPrompt, history, toolDefinitions, toolResults, thinking, response, total };
}

/**
 * Format a TokenBreakdown into a human-readable multi-line summary.
 */
export function formatBreakdown(breakdown: TokenBreakdown): string {
  const lines: string[] = [];
  const pad = (label: string, value: number) =>
    `  ${label.padEnd(20)} ${value.toLocaleString().padStart(10)} tokens`;

  lines.push("Token Breakdown:");
  lines.push(pad("System prompt", breakdown.systemPrompt));
  lines.push(pad("History", breakdown.history));
  lines.push(pad("Tool definitions", breakdown.toolDefinitions));
  lines.push(pad("Tool results", breakdown.toolResults));
  if (breakdown.thinking > 0) {
    lines.push(pad("Thinking", breakdown.thinking));
  }
  if (breakdown.response > 0) {
    lines.push(pad("Response", breakdown.response));
  }
  lines.push(`  ${"Total".padEnd(20)} ${breakdown.total.toLocaleString().padStart(10)} tokens`);

  return lines.join("\n");
}
