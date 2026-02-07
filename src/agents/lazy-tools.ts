import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

// ---------------------------------------------------------------------------
// Lazy tool loading: filter the full tool set to only include tools relevant
// to the current user message + recent conversation history.
//
// Safety principle: when in doubt, include the tool (false positives are far
// less costly than missing a tool the model actually needs).
// ---------------------------------------------------------------------------

/** Tool names that are always included regardless of message content. */
const CORE_TOOL_NAMES = new Set([
  "exec",
  "read",
  "write",
  "edit",
  "find",
  "grep",
  "ls",
  "process",
  "apply_patch",
  // Memory tools should always be available when present.
  "memory_search",
  "memory_get",
]);

// ---------------------------------------------------------------------------
// Conditional tool groups: each entry maps a set of tool names to the keyword
// patterns that should trigger their inclusion.
// ---------------------------------------------------------------------------

type ConditionalGroup = {
  /** Tool name prefixes / exact names to match. */
  tools: string[];
  /** Patterns (case-insensitive) that trigger inclusion when found in message or history. */
  triggers: RegExp;
};

const CONDITIONAL_GROUPS: ConditionalGroup[] = [
  {
    tools: ["browser", "web_search", "web_fetch"],
    triggers:
      /\b(url|http|https|www\.|browse|browser|web|search|google|fetch|scrape|crawl|website|webpage|link|open .* page|look\s*up)\b/i,
  },
  {
    tools: ["canvas"],
    triggers: /\b(canvas|ui|visual|draw|sketch|diagram|chart|render|paint|pixel|svg|a2ui)\b/i,
  },
  {
    tools: ["nodes"],
    triggers:
      /\b(device|camera|screen|node|screenshot|capture|display|monitor|peekaboo|peripheral)\b/i,
  },
  {
    tools: ["cron"],
    triggers: /\b(schedul|remind|timer|cron|alarm|recurring|interval|every\s+\d+|at\s+\d{1,2}:)\b/i,
  },
  {
    tools: ["message"],
    triggers:
      /\b(send|message|notify|tell|reply|forward|dm|whatsapp|telegram|discord|slack|signal|sms|text\s+(me|them|him|her|us))\b/i,
  },
  {
    tools: ["sessions_list", "sessions_send", "sessions_spawn", "sessions_history", "session_status", "agents_list"],
    triggers: /\b(session|agent|spawn|delegate|subagent|sub-agent|fork|parallel|concurrent)\b/i,
  },
  {
    tools: ["image"],
    triggers:
      /\b(image|picture|photo|screenshot|png|jpg|jpeg|gif|svg|bitmap|analyze\s*image|vision|ocr)\b/i,
  },
  {
    tools: ["gateway"],
    triggers: /\b(gateway|update|restart|config|upgrade|openclaw\s+(config|update|restart))\b/i,
  },
  {
    tools: ["tts"],
    triggers: /\b(tts|text[- ]to[- ]speech|speak|voice|say|read\s*aloud|audio|narrat)\b/i,
  },
];

/**
 * Extract a simple text representation from recent history messages for
 * keyword scanning. We look at the last few user messages to catch
 * multi-turn context (e.g. user says "search the web" then follows up
 * with a URL in the next message).
 */
function extractRecentHistoryText(recentHistory?: AgentMessage[], maxMessages = 6): string {
  if (!recentHistory || recentHistory.length === 0) {
    return "";
  }

  const parts: string[] = [];
  const tail = recentHistory.slice(-maxMessages);
  for (const msg of tail) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join(" ");
}

/**
 * Given the full set of agent tools, return a filtered subset that is
 * relevant to the current request.
 *
 * @param allTools - complete tool list produced by `createOpenClawCodingTools`
 * @param message  - the current user message text
 * @param recentHistory - recent conversation messages (optional, for multi-turn context)
 * @returns filtered tool array (always a subset of `allTools`, never adds tools)
 */
export function selectRelevantTools(
  allTools: AnyAgentTool[],
  message: string,
  recentHistory?: AgentMessage[],
): AnyAgentTool[] {
  // Build the combined text corpus to scan for trigger keywords.
  const historyText = extractRecentHistoryText(recentHistory);
  const corpus = `${message} ${historyText}`;

  // Pre-compute which conditional groups are triggered.
  const triggeredToolNames = new Set<string>();
  for (const group of CONDITIONAL_GROUPS) {
    if (group.triggers.test(corpus)) {
      for (const toolName of group.tools) {
        triggeredToolNames.add(toolName);
      }
    }
  }

  return allTools.filter((tool) => {
    const name = tool.name?.trim().toLowerCase();
    if (!name) {
      // Unknown tool -- include for safety.
      return true;
    }

    // Core tools are always included.
    if (CORE_TOOL_NAMES.has(name)) {
      return true;
    }

    // If the tool was triggered by keyword matching, include it.
    if (triggeredToolNames.has(name)) {
      return true;
    }

    // Plugin tools (names not in our conditional groups) are always included
    // to avoid accidentally hiding extension-provided capabilities.
    const isKnownConditional = CONDITIONAL_GROUPS.some((group) => group.tools.includes(name));
    if (!isKnownConditional) {
      return true;
    }

    // The tool is a known conditional tool that was not triggered -- exclude.
    return false;
  });
}
