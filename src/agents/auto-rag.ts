import type { OpenClawConfig } from "../config/config.js";

/**
 * Automatic RAG (Retrieval-Augmented Generation) layer.
 *
 * Determines whether a user message would benefit from a memory search
 * and extracts search queries -- all via lightweight heuristics (no LLM).
 * The caller is responsible for actually executing the searches.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoRAGConfig = {
  /** Enable automatic pre-search before responses (default: true). */
  enabled: boolean;
};

export type AutoRAGResult = {
  /** Whether a memory search is recommended for this message. */
  shouldSearch: boolean;
  /** Extracted search queries (1-3) when shouldSearch is true. */
  queries: string[];
};

// ---------------------------------------------------------------------------
// Pattern sets
// ---------------------------------------------------------------------------

/** Temporal references that suggest the user is asking about past context. */
const TEMPORAL_PATTERNS: RegExp[] = [
  /\blast\s+time\b/i,
  /\bbefore\b/i,
  /\bpreviously\b/i,
  /\bearlier\b/i,
  /\byesterday\b/i,
  /\blast\s+(?:week|month|session|conversation|chat)\b/i,
  /\bremember\s+(?:when|that|the)\b/i,
  /\bwe\s+(?:discussed|talked|decided|agreed|said)\b/i,
  /\byou\s+(?:said|told|mentioned|suggested|recommended)\b/i,
  /\bwhat\s+(?:did\s+(?:we|you|i))\b/i,
  /\bhistory\b/i,
];

/** Patterns that indicate the user is asking about preferences/decisions. */
const PREFERENCE_PATTERNS: RegExp[] = [
  /\bprefer(?:ence|red|s)?\b/i,
  /\bdecid(?:e|ed|sion)\b/i,
  /\bchos(?:e|en|ice)\b/i,
  /\bagreed?\b/i,
  /\bmy\s+(?:usual|default|standard|normal|favorite)\b/i,
  /\bdo\s+(?:i|we)\s+(?:have|use|like|want)\b/i,
  /\bwhat\s+(?:is|was)\s+(?:my|our)\b/i,
];

/** Patterns suggesting the user references a person, project, or entity. */
const ENTITY_PATTERNS: RegExp[] = [
  /\b(?:about|regarding|concerning)\s+(?:[A-Z][a-z]+)\b/,
  /\btodo(?:s)?\b/i,
  /\btask(?:s)?\b/i,
  /\bproject\b/i,
  /\bticket\b/i,
  /\bissue\s*#?\d+\b/i,
  /\bPR\s*#?\d+\b/i,
];

/** Patterns that clearly indicate no memory search is needed. */
const SKIP_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey|thanks|thank\s*you|ok|okay|sure|yes|no|yep|nope)\s*[!?.]*$/i,
  /^\/\w+/,
  /\b(?:write|create|generate|make)\s+(?:a|an|the|me|some)\b/i,
  /\b(?:fix|update|change|modify|edit|delete|remove)\s+(?:this|the|that|it)\b/i,
  /\brun\b/i,
  /\bcommit\b/i,
  /\bpush\b/i,
  /\bdeploy\b/i,
  /\binstall\b/i,
];

// ---------------------------------------------------------------------------
// AutoRAG class
// ---------------------------------------------------------------------------

export class AutoRAG {
  /**
   * Determine whether a memory search would help answer this message.
   *
   * @param message - The user message to analyze.
   * @param recentHistory - Optional recent message strings for additional context.
   */
  shouldSearch(message: string, recentHistory?: string[]): boolean {
    const trimmed = message.trim();
    if (!trimmed || trimmed.length < 5) {
      return false;
    }

    // Skip obvious commands and greetings.
    for (const pattern of SKIP_PATTERNS) {
      if (pattern.test(trimmed)) {
        return false;
      }
    }

    // Check for temporal, preference, or entity references.
    for (const pattern of TEMPORAL_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    for (const pattern of PREFERENCE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    for (const pattern of ENTITY_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    // If recent history references "remember" or "we discussed", boost.
    if (recentHistory?.length) {
      const joined = recentHistory.join(" ");
      if (/\bremember\b/i.test(joined) || /\bwe\s+discussed\b/i.test(joined)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract 1-3 search queries from a user message.
   * Uses simple NLP heuristics: splits on sentence boundaries, removes
   * stop words, and keeps the most meaningful fragments.
   */
  getSearchQueries(message: string): string[] {
    const trimmed = message.trim();
    if (!trimmed) {
      return [];
    }

    const queries: string[] = [];

    // Split into sentences.
    const sentences = trimmed
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 3);

    if (sentences.length === 0) {
      // Fallback: use the entire message (truncated).
      queries.push(truncateQuery(trimmed));
      return queries;
    }

    // Extract the most meaningful sentence fragments as queries.
    for (const sentence of sentences.slice(0, 3)) {
      const cleaned = stripLeadingStopPhrases(sentence);
      if (cleaned.length > 3) {
        queries.push(truncateQuery(cleaned));
      }
    }

    // Deduplicate while preserving order.
    return deduplicateQueries(queries.length > 0 ? queries : [truncateQuery(trimmed)]);
  }

  /**
   * Format search results as a context prefix for injection into the prompt.
   */
  buildRAGContext(searchResults: string[]): string {
    if (searchResults.length === 0) {
      return "";
    }

    const lines: string[] = [
      "[Memory context — retrieved from previous sessions]",
    ];

    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i]?.trim();
      if (result) {
        lines.push(`[${i + 1}] ${result}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether automatic RAG should be triggered for a message.
 * Returns the decision and extracted queries.
 */
export function resolveAutoRAG(
  message: string,
  config?: OpenClawConfig,
): AutoRAGResult {
  const ragConfig = resolveAutoRAGConfig(config);
  if (!ragConfig.enabled) {
    return { shouldSearch: false, queries: [] };
  }

  const rag = new AutoRAG();
  const shouldSearch = rag.shouldSearch(message);
  const queries = shouldSearch ? rag.getSearchQueries(message) : [];

  return { shouldSearch, queries };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAutoRAGConfig(config?: OpenClawConfig): AutoRAGConfig {
  const raw = (config?.agents?.defaults as Record<string, unknown> | undefined)?.autoRAG;
  if (typeof raw === "boolean") {
    return { enabled: raw };
  }
  return { enabled: true };
}

/** Leading stop phrases to strip from query fragments. */
const STOP_PHRASE_PATTERN =
  /^(?:can you|could you|please|would you|do you|what is|what are|tell me|show me|help me)\s+/i;

function stripLeadingStopPhrases(text: string): string {
  let result = text;
  // Apply repeatedly in case of stacking ("can you please tell me...").
  for (let i = 0; i < 3; i++) {
    const stripped = result.replace(STOP_PHRASE_PATTERN, "");
    if (stripped === result) {
      break;
    }
    result = stripped;
  }
  return result;
}

/** Truncate a query to a reasonable length for memory search. */
function truncateQuery(query: string, maxLength = 200): string {
  if (query.length <= maxLength) {
    return query;
  }
  // Cut at last word boundary before maxLength.
  const cut = query.lastIndexOf(" ", maxLength);
  return cut > 0 ? query.slice(0, cut) : query.slice(0, maxLength);
}

/** Remove duplicate queries (case-insensitive). */
function deduplicateQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const query of queries) {
    const lower = query.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(query);
    }
  }
  return result;
}
