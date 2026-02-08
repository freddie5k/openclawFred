import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Default char threshold above which tool results get summarized. */
const DEFAULT_MAX_CHARS = 2000;

/** Number of recent turns (user messages) whose tool results are kept intact. */
const DEFAULT_RECENT_TURNS = 3;

/**
 * Summarize a single tool result string when it exceeds `maxChars`.
 *
 * Strategy varies by tool name:
 * - `exec`: keep first 500 + last 500 chars with a truncation note.
 * - `read`: keep first 200 + file metadata + last 200 chars.
 * - `grep`/`find`/`glob`: keep first 20 match lines + total match count.
 * - `web_fetch`/`web_search`: keep first 1000 chars.
 * - All others: keep first 500 chars with a truncation note.
 */
export function summarizeToolResult(
  toolName: string,
  result: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  if (result.length <= maxChars) {
    return result;
  }

  const name = toolName.toLowerCase();

  if (name === "exec" || name === "bash" || name === "shell") {
    const head = result.slice(0, 500);
    const tail = result.slice(-500);
    const dropped = result.length - 1000;
    return `${head}\n... (truncated ${dropped} chars) ...\n${tail}`;
  }

  if (name === "read" || name === "read_file") {
    const lines = result.split("\n");
    const lineCount = lines.length;
    const head = lines.slice(0, 8).join("\n");
    const tail = lines.slice(-8).join("\n");
    return (
      `${head.slice(0, 200)}\n` +
      `... (File: ${lineCount} lines, ${result.length} chars) ...\n` +
      tail.slice(-200)
    );
  }

  if (name === "grep" || name === "find" || name === "glob" || name === "search") {
    const lines = result.split("\n").filter(Boolean);
    const totalMatches = lines.length;
    const kept = lines.slice(0, 20).join("\n");
    if (totalMatches > 20) {
      return `${kept}\n... (${totalMatches} total matches, showing first 20)`;
    }
    // Fewer than 20 lines but still over maxChars; truncate the kept portion.
    return `${kept.slice(0, maxChars)}\n... (truncated)`;
  }

  if (name === "web_fetch" || name === "web_search") {
    return `${result.slice(0, 1000)}\n... (truncated ${result.length - 1000} chars)`;
  }

  // Fallback for any other tool.
  return `${result.slice(0, 500)}\n... (truncated ${result.length - 500} chars)`;
}

// ---------------------------------------------------------------------------
// History-level summarization
// ---------------------------------------------------------------------------

export type SummarizeHistoryOptions = {
  /** Char threshold for individual tool results (default: 2000). */
  maxChars?: number;
  /** Number of recent user turns whose tool results are preserved (default: 3). */
  recentTurnsToKeep?: number;
};

/**
 * Count user turns from the end of the message array and return the index
 * at which "old" messages start (i.e. messages before the N-th most recent
 * user turn).
 */
function findOldMessageBoundary(messages: AgentMessage[], recentTurns: number): number {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount >= recentTurns) {
        return i;
      }
    }
  }
  // Fewer user turns than recentTurns -- everything is "recent".
  return 0;
}

/**
 * Extract the text payload from a tool-result message.
 * Returns `null` when the content shape is unrecognised.
 */
function extractToolResultText(msg: AgentMessage): string | null {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block: unknown) =>
        block != null && typeof block === "object" && (block as { type?: string }).type === "text",
    ) as { text?: string } | undefined;
    return textBlock?.text ?? null;
  }
  return null;
}

/**
 * Resolve the tool name associated with a toolResult message by looking
 * backwards through the history for the matching assistant tool-call.
 */
function resolveToolName(messages: AgentMessage[], resultIndex: number): string {
  const msg = messages[resultIndex] as { toolCallId?: string; toolName?: string };
  if (msg.toolName) {
    return msg.toolName;
  }
  const callId = msg.toolCallId;
  if (!callId) {
    return "unknown";
  }
  for (let i = resultIndex - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev.role !== "assistant" || !Array.isArray(prev.content)) {
      continue;
    }
    for (const block of prev.content) {
      const rec = block as { type?: string; id?: string; name?: string };
      if (
        (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") &&
        rec.id === callId
      ) {
        return rec.name ?? "unknown";
      }
    }
  }
  return "unknown";
}

/**
 * Walk conversation history and produce a shallow copy with older
 * tool-result payloads summarized.  Recent turns (default: last 3 user
 * messages and their associated assistant/tool turns) are kept verbatim so
 * the model can still reference them.
 *
 * The function never mutates the input array or its messages.
 */
export function summarizeHistoryToolResults(
  messages: AgentMessage[],
  options?: SummarizeHistoryOptions,
): AgentMessage[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const recentTurns = options?.recentTurnsToKeep ?? DEFAULT_RECENT_TURNS;

  if (messages.length === 0) {
    return messages;
  }

  const boundary = findOldMessageBoundary(messages, recentTurns);
  if (boundary === 0) {
    // Everything is recent; nothing to summarize.
    return messages;
  }

  let didChange = false;
  const result: AgentMessage[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only summarize toolResult messages in the "old" portion.
    if (i < boundary && msg.role === "toolResult") {
      const text = extractToolResultText(msg);
      if (text !== null && text.length > maxChars) {
        const toolName = resolveToolName(messages, i);
        const summarized = summarizeToolResult(toolName, text, maxChars);
        // Shallow clone with replaced content.
        result[i] = {
          ...msg,
          content: [{ type: "text", text: summarized }],
        } as AgentMessage;
        didChange = true;
        continue;
      }
    }

    result[i] = msg;
  }

  return didChange ? result : messages;
}
