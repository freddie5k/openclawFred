import type { OpenClawConfig } from "../config/config.js";

/**
 * Lightweight heuristic planning layer for multi-step tasks.
 *
 * Analyzes user messages to determine complexity and injects a planning
 * prompt prefix that encourages structured execution. No LLM calls --
 * purely keyword/pattern based.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskComplexity = "single-step" | "multi-step" | "research";

export type PlanningConfig = {
  /** Enable the planning layer (default: true). */
  enabled: boolean;
};

// ---------------------------------------------------------------------------
// Pattern sets used for heuristic classification
// ---------------------------------------------------------------------------

/** Phrases that signal a multi-step or sequential task. */
const MULTI_STEP_PATTERNS: RegExp[] = [
  /\b(?:then|after that|next|afterward|finally|step\s*\d)\b/i,
  /\b(?:first|second|third)\b.*\b(?:then|next|after)\b/i,
  /\band\s+(?:also|then)\b/i,
  /\bset\s*up\b/i,
  /\bimplement\b/i,
  /\brefactor\b/i,
  /\bmigrate\b/i,
  /\bbuild\b.*\b(?:and|with)\b/i,
  /\bcreate\b.*\b(?:and|with|then)\b/i,
  /\binstall\b.*\b(?:and|then|configure)\b/i,
  /\bdeploy\b/i,
];

/** Phrases that signal a research or investigation task. */
const RESEARCH_PATTERNS: RegExp[] = [
  /\b(?:find|search|look\s*up|investigate|research|explore|dig\s*into)\b/i,
  /\bhow\s+(?:does|do|did|can|could|would|is|are)\b/i,
  /\bwhat\s+(?:is|are|was|were|does|do|happened)\b/i,
  /\bwhy\s+(?:does|do|did|is|are|was|were)\b/i,
  /\bwhere\s+(?:is|are|does|do|did|can)\b/i,
  /\bcompare\b/i,
  /\banalyze\b/i,
  /\bexplain\b/i,
  /\bdebug\b/i,
  /\btroubleshoot\b/i,
  /\bdiagnose\b/i,
];

/** Phrases that strongly suggest a trivial / single-step task. */
const SINGLE_STEP_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey|thanks|thank\s*you|ok|okay|sure|yes|no|yep|nope)\s*[!?.]*$/i,
  /^\/\w+/,
  /\brun\b.*\btest/i,
  /\bcommit\b/i,
  /\bpush\b/i,
  /\bsend\b/i,
  /\brestart\b/i,
];

/** Structural cues: numbered lists, bullet lists, comma-separated commands. */
const LIST_PATTERN = /(?:^\s*[-*]\s+.+\n?){2,}|(?:^\s*\d+[.)]\s+.+\n?){2,}/m;
const COMMA_LIST_PATTERN = /,\s*(?:and\s+)?(?:\w+\s+){1,4}(?:,|$)/i;

// ---------------------------------------------------------------------------
// TaskPlanner
// ---------------------------------------------------------------------------

export class TaskPlanner {
  /**
   * Classify the user message into a complexity bucket using keyword heuristics.
   * Returns "single-step", "multi-step", or "research".
   */
  analyzeTaskComplexity(message: string): TaskComplexity {
    const trimmed = message.trim();
    if (!trimmed) {
      return "single-step";
    }

    // Short messages (under 20 chars) are almost always single-step.
    if (trimmed.length < 20) {
      for (const pattern of SINGLE_STEP_PATTERNS) {
        if (pattern.test(trimmed)) {
          return "single-step";
        }
      }
    }

    // Check for explicit single-step signals first.
    for (const pattern of SINGLE_STEP_PATTERNS) {
      if (pattern.test(trimmed)) {
        return "single-step";
      }
    }

    // Check for structural list cues (numbered/bulleted items).
    if (LIST_PATTERN.test(trimmed) || COMMA_LIST_PATTERN.test(trimmed)) {
      return "multi-step";
    }

    // Score multi-step vs research patterns.
    let multiStepScore = 0;
    let researchScore = 0;

    for (const pattern of MULTI_STEP_PATTERNS) {
      if (pattern.test(trimmed)) {
        multiStepScore += 1;
      }
    }

    for (const pattern of RESEARCH_PATTERNS) {
      if (pattern.test(trimmed)) {
        researchScore += 1;
      }
    }

    // Word count as a secondary signal: longer messages are more likely multi-step.
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount > 40) {
      multiStepScore += 1;
    }

    if (multiStepScore > 0 && multiStepScore >= researchScore) {
      return "multi-step";
    }
    if (researchScore > 0) {
      return "research";
    }

    return "single-step";
  }

  /**
   * Generate a prompt prefix based on task complexity.
   * Returns an empty string for single-step tasks to avoid overhead.
   */
  generatePlanPrompt(message: string, complexity: TaskComplexity): string {
    switch (complexity) {
      case "multi-step":
        return [
          "[Planning — multi-step task detected]",
          "Before executing, outline your plan in 2-3 bullet points.",
          "Track progress as you go. If a step fails, re-evaluate the remaining plan.",
          "",
        ].join("\n");

      case "research":
        return [
          "[Planning — research task detected]",
          "Before searching, identify what you need to find and in what order.",
          "Summarize findings after each search step before proceeding to the next.",
          "",
        ].join("\n");

      case "single-step":
      default:
        return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a planning prompt prefix for the given user message.
 * Returns an empty string when planning is disabled or the task is trivial.
 */
export function resolvePlanningPrompt(
  message: string,
  config?: OpenClawConfig,
): string {
  const planningConfig = resolvePlanningConfig(config);
  if (!planningConfig.enabled) {
    return "";
  }

  const planner = new TaskPlanner();
  const complexity = planner.analyzeTaskComplexity(message);
  return planner.generatePlanPrompt(message, complexity);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolvePlanningConfig(config?: OpenClawConfig): PlanningConfig {
  // Planning defaults to true; read from agents.defaults.planning when available.
  const raw = (config?.agents?.defaults as Record<string, unknown> | undefined)?.planning;
  if (typeof raw === "boolean") {
    return { enabled: raw };
  }
  return { enabled: true };
}
