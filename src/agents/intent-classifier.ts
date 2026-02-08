import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";

export type IntentComplexity = "simple" | "moderate" | "complex";

export type ClassifiedIntent = {
  complexity: IntentComplexity;
  suggestedModel?: string;
  suggestedThinking?: ThinkLevel;
};

// ---------------------------------------------------------------------------
// Pattern-based intent classification (no LLM call -- must be instant).
// ---------------------------------------------------------------------------

// Greeting / farewell patterns (case-insensitive).
const GREETING_RE =
  /^(h(i|ey|ello|owdy)|yo|sup|thanks?|thank\s*you|bye|goodbye|good\s*(morning|evening|night|afternoon)|cheers|gm|gn|ttyl|cya|lol|ok(ay)?|sure|yep|yup|nope|nah|yes|no|wow|cool|nice|great|awesome|k)\b/i;

// Questions that are typically short factual lookups.
const SIMPLE_QUESTION_RE =
  /^(what('?s| is| are)|who('?s| is| are)|where('?s| is| are)|when('?s| is| are)|how (much|many|old|long|far|tall)|is (it|there|this|that)|can you|do you|did you|are you)\b/i;

// Status check patterns.
const STATUS_CHECK_RE =
  /\b(status|uptime|ping|health|alive|running|version|what time|current time|date today)\b/i;

// Patterns that indicate complex work.
const COMPLEX_PATTERNS: RegExp[] = [
  // Code generation / editing.
  /\b(write|create|implement|build|generate|refactor|rewrite|migrate|convert|port)\b.*\b(code|function|class|module|component|script|program|api|endpoint|service|app|test|cli)\b/i,
  // Debugging / fixing.
  /\b(debug|fix|solve|troubleshoot|diagnose|investigate|trace|bisect|patch)\b/i,
  // Multi-step operations.
  /\b(step[- ]by[- ]step|multi[- ]step|first .* then|pipeline|workflow|deploy|release|migration)\b/i,
  // File system operations.
  /\b(create|edit|modify|delete|move|rename|read|write)\b.*\b(file|directory|folder|path)\b/i,
  // Analysis.
  /\b(analyze|analyse|review|audit|compare|diff|profile|benchmark|optimize|explain .* code)\b/i,
  // Long-form generation.
  /\b(essay|report|document|summary|summarize|outline|plan|design|architecture|spec|proposal)\b/i,
  // Shell / system commands.
  /\b(run|execute|install|uninstall|configure|setup|set up|docker|npm|pip|apt|brew|curl|wget|ssh|git)\b/i,
];

// Moderate-complexity signals (present but not enough for "complex" on their own).
const MODERATE_PATTERNS: RegExp[] = [
  /\b(explain|describe|elaborate|clarify|compare|list|enumerate|translate)\b/i,
  /\b(how (do|does|can|should|would|to)|why (is|does|do|are|did|would))\b/i,
  /\b(example|sample|snippet|template|boilerplate)\b/i,
];

const WORD_SPLIT_RE = /\s+/;

function countWords(text: string): number {
  return text.trim().split(WORD_SPLIT_RE).filter(Boolean).length;
}

function hasCodeIndicators(text: string): boolean {
  // Fenced code blocks, backtick inline code, or common code symbols.
  return /```|`[^`]+`|[{}<>]=?|=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bimport\b|\bclass\b/i.test(
    text,
  );
}

/**
 * Classify a user message by complexity using fast keyword / pattern matching.
 * This must NOT invoke an LLM -- it runs synchronously and returns instantly.
 */
export function classifyIntent(message: string): ClassifiedIntent {
  const trimmed = message.trim();
  if (!trimmed) {
    return { complexity: "simple", suggestedThinking: "off" };
  }

  const words = countWords(trimmed);

  // Very short greetings / yes-no / status checks.
  if (words <= 5 && GREETING_RE.test(trimmed)) {
    return { complexity: "simple", suggestedThinking: "off" };
  }

  if (words <= 3 && /^[^a-z]*$/i.test(trimmed)) {
    // Emojis / reactions only.
    return { complexity: "simple", suggestedThinking: "off" };
  }

  // Status checks at any length.
  if (STATUS_CHECK_RE.test(trimmed) && words <= 10) {
    return { complexity: "simple", suggestedThinking: "off" };
  }

  // Short factual questions without code.
  if (words < 20 && !hasCodeIndicators(trimmed) && SIMPLE_QUESTION_RE.test(trimmed)) {
    return { complexity: "simple", suggestedThinking: "off" };
  }

  // Check complex patterns first (they are more specific).
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { complexity: "complex", suggestedThinking: "low" };
    }
  }

  // Code indicators strongly suggest complex.
  if (hasCodeIndicators(trimmed)) {
    return { complexity: "complex", suggestedThinking: "low" };
  }

  // Moderate signals.
  for (const pattern of MODERATE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { complexity: "moderate", suggestedThinking: "minimal" };
    }
  }

  // Long messages without other signals lean toward moderate.
  if (words >= 30) {
    return { complexity: "moderate", suggestedThinking: "minimal" };
  }

  // Default: moderate (safe middle ground).
  return { complexity: "moderate", suggestedThinking: "off" };
}

// ---------------------------------------------------------------------------
// Model resolution based on classified intent + config.
// ---------------------------------------------------------------------------

export type SmartRoutingConfig = {
  /** Enable smart model routing based on message complexity (default: false). */
  enabled?: boolean;
  /** Model to use for simple messages (provider/model). Falls back to default model. */
  simpleModel?: string;
  /** Model to use for moderate messages (provider/model). Falls back to default model. */
  moderateModel?: string;
};

/**
 * Given a classified intent, pick the best model.
 * Returns undefined when the default model should be used (no override).
 */
export function resolveModelForIntent(
  intent: ClassifiedIntent,
  defaultModel: string,
  config?: OpenClawConfig,
): string {
  const routing = resolveSmartRoutingConfig(config);
  if (!routing.enabled) {
    return defaultModel;
  }

  switch (intent.complexity) {
    case "simple":
      return routing.simpleModel?.trim() || defaultModel;
    case "moderate":
      return routing.moderateModel?.trim() || defaultModel;
    case "complex":
      // Complex always uses the default (most capable) model.
      return defaultModel;
    default:
      return defaultModel;
  }
}

/**
 * Read the smart-routing configuration from the OpenClaw config.
 * Expected path: `agents.defaults.smartRouting`.
 */
function resolveSmartRoutingConfig(config?: OpenClawConfig): SmartRoutingConfig {
  // The smartRouting key lives alongside other agent defaults.
  // We read it as an untyped record to avoid changing the config type in this PR.
  const defaults = config?.agents?.defaults as Record<string, unknown> | undefined;
  const raw = defaults?.smartRouting;
  if (!raw || typeof raw !== "object") {
    return { enabled: false };
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    simpleModel: typeof obj.simpleModel === "string" ? obj.simpleModel : undefined,
    moderateModel: typeof obj.moderateModel === "string" ? obj.moderateModel : undefined,
  };
}
