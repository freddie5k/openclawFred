import type { OpenClawConfig } from "../config/config.js";

/**
 * Learning journal and self-evaluation system.
 *
 * Extracts lessons from session history using heuristic analysis
 * and provides a scoring system for session quality. No LLM calls --
 * all analysis is pattern-based.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LearningJournalConfig = {
  /** Enable the learning journal (default: true). */
  enabled: boolean;
};

export type LessonEntry = {
  /** High-level category (e.g. "tool-usage", "error-recovery", "workflow"). */
  topic: string;
  /** The lesson learned. */
  lesson: string;
  /** Confidence in the lesson (0.0 - 1.0). */
  confidence: number;
  /** ISO timestamp when the lesson was extracted. */
  timestamp: string;
};

export type SessionOutcome = {
  /** Whether the session achieved its goal. */
  success: boolean;
  /** Whether the user expressed satisfaction (undefined = unknown). */
  userSatisfied?: boolean;
};

export type SessionEvaluation = {
  /** Overall session quality score (1-5). */
  score: number;
  /** What went well. */
  strengths: string[];
  /** What could be improved. */
  improvements: string[];
};

// ---------------------------------------------------------------------------
// Heuristic patterns for session analysis
// ---------------------------------------------------------------------------

/** Patterns that indicate an error occurred during the session. */
const ERROR_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bexception\b/i,
  /\bcrash(?:ed|es)?\b/i,
  /\btimeout\b/i,
  /\bdenied\b/i,
  /\bunauthorized\b/i,
  /\b(?:not\s+found|404)\b/i,
  /\bpermission\b/i,
];

/** Patterns indicating a retry or repeated attempt. */
const RETRY_PATTERNS: RegExp[] = [
  /\bretry\b/i,
  /\bretrying\b/i,
  /\btry\s+again\b/i,
  /\battempt\s+\d/i,
  /\bfallback\b/i,
];

/** Patterns indicating tool usage. */
const TOOL_CALL_PATTERN = /\btool_call\b|\bfunction_call\b|\bexecute\b/i;

/** Patterns indicating user satisfaction. */
const SATISFACTION_PATTERNS: RegExp[] = [
  /\bthanks?\b/i,
  /\bthank\s*you\b/i,
  /\bperfect\b/i,
  /\bgreat\b/i,
  /\bawesome\b/i,
  /\bexcellent\b/i,
  /\bworks?\b.*\b(?:well|great|perfectly)\b/i,
  /\bexactly\s+(?:what|right)\b/i,
  /\bnice\b/i,
];

/** Patterns indicating user dissatisfaction. */
const DISSATISFACTION_PATTERNS: RegExp[] = [
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bthat'?s?\s+not\s+(?:what|right)\b/i,
  /\bnot\s+(?:what\s+i|helpful|working|correct)\b/i,
  /\bstop\b/i,
  /\bno\s*,?\s*(?:that|this|i)\b/i,
  /\bundo\b/i,
  /\brevert\b/i,
];

// ---------------------------------------------------------------------------
// HistoryEntry -- minimal shape expected from session history items.
// We accept `any[]` in the public API but internally try to read these fields.
// ---------------------------------------------------------------------------

type HistoryEntry = {
  role?: string;
  content?: string;
  text?: string;
  error?: string;
  errorMessage?: string;
  toolName?: string;
  type?: string;
};

function extractText(entry: HistoryEntry): string {
  return entry.content ?? entry.text ?? entry.error ?? entry.errorMessage ?? "";
}

// ---------------------------------------------------------------------------
// LearningJournal
// ---------------------------------------------------------------------------

export class LearningJournal {
  private knownLessons = new Set<string>();

  /**
   * Analyze session history and extract lessons learned.
   *
   * Looks for patterns such as:
   * - Errors encountered and how they were resolved
   * - Tools that failed
   * - Successful strategies (short conversations for complex tasks)
   */
  extractLessons(
    sessionHistory: HistoryEntry[],
    outcome: SessionOutcome,
  ): LessonEntry[] {
    const lessons: LessonEntry[] = [];
    const now = new Date().toISOString();

    // Track error -> resolution patterns.
    const errors = this.findErrors(sessionHistory);
    const retries = this.countRetries(sessionHistory);

    // Lesson: error recovery.
    if (errors.length > 0 && outcome.success) {
      const errorTypes = [...new Set(errors.map((e) => e.type))];
      lessons.push({
        topic: "error-recovery",
        lesson: `Successfully recovered from ${errors.length} error(s) (${errorTypes.join(", ")}). ` +
          `${retries > 0 ? `Used ${retries} retry attempt(s).` : "Resolved without retries."}`,
        confidence: 0.8,
        timestamp: now,
      });
    }

    // Lesson: persistent failures.
    if (errors.length > 2 && !outcome.success) {
      lessons.push({
        topic: "error-recovery",
        lesson: `Encountered ${errors.length} errors without resolution. ` +
          "Consider alternative approaches or escalating earlier.",
        confidence: 0.7,
        timestamp: now,
      });
    }

    // Lesson: tool failures.
    const failedTools = this.findFailedTools(sessionHistory);
    if (failedTools.length > 0) {
      const toolNames = [...new Set(failedTools)];
      lessons.push({
        topic: "tool-usage",
        lesson: `Tool(s) that encountered issues: ${toolNames.join(", ")}. ` +
          "Verify tool availability and input parameters before use.",
        confidence: 0.6,
        timestamp: now,
      });
    }

    // Lesson: efficient workflows.
    const messageCount = sessionHistory.length;
    if (outcome.success && messageCount < 10) {
      lessons.push({
        topic: "workflow",
        lesson: "Task completed efficiently in fewer than 10 exchanges.",
        confidence: 0.5,
        timestamp: now,
      });
    }

    // Lesson: user satisfaction signals.
    if (outcome.userSatisfied === true) {
      lessons.push({
        topic: "interaction",
        lesson: "User expressed satisfaction with the result.",
        confidence: 0.9,
        timestamp: now,
      });
    } else if (outcome.userSatisfied === false) {
      lessons.push({
        topic: "interaction",
        lesson: "User expressed dissatisfaction. Review approach and ask clarifying questions earlier.",
        confidence: 0.85,
        timestamp: now,
      });
    }

    return lessons.filter((lesson) => this.shouldRecord(lesson));
  }

  /**
   * Deduplication check: returns true if this lesson is novel enough to record.
   */
  shouldRecord(lesson: LessonEntry): boolean {
    // Build a fingerprint from topic + core lesson content.
    const fingerprint = `${lesson.topic}:${lesson.lesson.slice(0, 80).toLowerCase()}`;
    if (this.knownLessons.has(fingerprint)) {
      return false;
    }
    this.knownLessons.add(fingerprint);
    return true;
  }

  /**
   * Format lessons as markdown suitable for appending to MEMORY.md.
   */
  formatForMemory(lessons: LessonEntry[]): string {
    if (lessons.length === 0) {
      return "";
    }

    const lines: string[] = [
      "## Learning Journal",
      "",
    ];

    for (const lesson of lessons) {
      const date = lesson.timestamp.split("T")[0] ?? lesson.timestamp;
      lines.push(
        `- **[${lesson.topic}]** (${date}, confidence: ${lesson.confidence.toFixed(1)})`,
        `  ${lesson.lesson}`,
      );
    }

    lines.push("");
    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private findErrors(history: HistoryEntry[]): Array<{ type: string; index: number }> {
    const errors: Array<{ type: string; index: number }> = [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (!entry) {
        continue;
      }
      const text = extractText(entry);
      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(text)) {
          const type = classifyError(text);
          errors.push({ type, index: i });
          break;
        }
      }
    }
    return errors;
  }

  private countRetries(history: HistoryEntry[]): number {
    let count = 0;
    for (const entry of history) {
      if (!entry) {
        continue;
      }
      const text = extractText(entry);
      for (const pattern of RETRY_PATTERNS) {
        if (pattern.test(text)) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  private findFailedTools(history: HistoryEntry[]): string[] {
    const failed: string[] = [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (!entry) {
        continue;
      }
      const text = extractText(entry);
      const isToolRelated = TOOL_CALL_PATTERN.test(text) || entry.toolName;
      const hasError = ERROR_PATTERNS.some((p) => p.test(text));
      if (isToolRelated && hasError) {
        failed.push(entry.toolName ?? "unknown_tool");
      }
    }
    return failed;
  }
}

// ---------------------------------------------------------------------------
// SelfEvaluator
// ---------------------------------------------------------------------------

export class SelfEvaluator {
  /**
   * Evaluate a session using heuristics.
   *
   * Scoring rubric (1-5):
   * - 5: No errors, efficient, user satisfied
   * - 4: Minor issues resolved quickly
   * - 3: Some errors but ultimately successful
   * - 2: Multiple retries, user had to correct
   * - 1: Failed to complete, user dissatisfied
   */
  evaluateSession(history: HistoryEntry[]): SessionEvaluation {
    const strengths: string[] = [];
    const improvements: string[] = [];
    let score = 3; // Start at neutral.

    const messageCount = history.length;
    const errorCount = countPatternMatches(history, ERROR_PATTERNS);
    const retryCount = countPatternMatches(history, RETRY_PATTERNS);
    const satisfactionCount = countPatternMatches(history, SATISFACTION_PATTERNS);
    const dissatisfactionCount = countPatternMatches(history, DISSATISFACTION_PATTERNS);

    // Efficiency: fewer messages for the task is better.
    if (messageCount > 0 && messageCount <= 10) {
      score += 1;
      strengths.push("Efficient conversation (10 or fewer exchanges).");
    } else if (messageCount > 30) {
      score -= 1;
      improvements.push("Long conversation; consider more direct approaches.");
    }

    // Error handling.
    if (errorCount === 0) {
      score += 1;
      strengths.push("No errors encountered.");
    } else if (errorCount <= 2) {
      improvements.push(`${errorCount} error(s) encountered but managed.`);
    } else {
      score -= 1;
      improvements.push(`${errorCount} errors encountered; review error prevention.`);
    }

    // Retries.
    if (retryCount === 0) {
      strengths.push("No retries needed.");
    } else if (retryCount >= 3) {
      score -= 1;
      improvements.push(`${retryCount} retries; consider validating inputs earlier.`);
    }

    // User sentiment.
    if (satisfactionCount > 0 && dissatisfactionCount === 0) {
      score += 1;
      strengths.push("Positive user feedback received.");
    } else if (dissatisfactionCount > 0) {
      score -= 1;
      improvements.push("User expressed dissatisfaction; ask clarifying questions earlier.");
    }

    // Clamp score to 1-5.
    score = Math.max(1, Math.min(5, score));

    // Ensure at least one entry in each list.
    if (strengths.length === 0) {
      strengths.push("Session completed.");
    }
    if (improvements.length === 0) {
      improvements.push("No specific improvements identified.");
    }

    return { score, strengths, improvements };
  }
}

// ---------------------------------------------------------------------------
// Public config resolution
// ---------------------------------------------------------------------------

export function resolveLearningJournalConfig(config?: OpenClawConfig): LearningJournalConfig {
  const raw = (config?.agents?.defaults as Record<string, unknown> | undefined)?.learningJournal;
  if (typeof raw === "boolean") {
    return { enabled: raw };
  }
  return { enabled: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyError(text: string): string {
  if (/timeout/i.test(text)) return "timeout";
  if (/permission|denied|unauthorized/i.test(text)) return "auth";
  if (/not\s+found|404/i.test(text)) return "not-found";
  if (/crash|exception/i.test(text)) return "crash";
  return "general";
}

function countPatternMatches(history: HistoryEntry[], patterns: RegExp[]): number {
  let count = 0;
  for (const entry of history) {
    if (!entry) continue;
    const text = extractText(entry);
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        count++;
        break;
      }
    }
  }
  return count;
}
