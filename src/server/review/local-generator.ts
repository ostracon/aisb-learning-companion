import { randomUUID } from "node:crypto";
import type {
  ReviewCoachGenerator,
  ReviewGenerationRequest,
  ReviewGenerationResult,
} from "./service.js";

interface EnvelopeOutcome {
  outcome_id: string;
}

interface ReviewEnvelope {
  operation: "ask_question" | "feedback_and_next_question";
  allowed_modes: string[];
  selected_outcomes: EnvelopeOutcome[];
  current_question?: { number?: number; outcome_ids?: string[] };
  next_question_required?: boolean;
}

function parseEnvelope(prompt: string): ReviewEnvelope {
  const jsonStart = prompt.indexOf("{");
  if (jsonStart === -1) throw new Error("The local review envelope is unavailable");
  const parsed = JSON.parse(prompt.slice(jsonStart)) as ReviewEnvelope;
  if (!Array.isArray(parsed.selected_outcomes) || parsed.selected_outcomes.length === 0) {
    throw new Error("The local review envelope has no outcomes");
  }
  return parsed;
}

function questionFor(outcome: EnvelopeOutcome, mode: string) {
  // The selected outcome remains visible beside the question in the UI. The
  // offline fallback deliberately uses a short, fixed retrieval move instead
  // of echoing a potentially composite outcome into another large task.
  const prompt = mode === "scenario_application"
    ? "Give one AI-security example that demonstrates this outcome."
    : mode === "compare_contrast"
      ? "Name one contrast that clarifies this outcome."
      : mode === "explain_back"
        ? "Explain one key idea from this outcome in your own words."
        : mode === "short_answer"
          ? "What single point best demonstrates this outcome?"
          : "What is the most important idea in this outcome?";
  return { mode, prompt, outcome_ids: [outcome.outcome_id] };
}

/**
 * A no-network fallback that provides useful recall prompts without claiming to
 * evaluate correctness. It deliberately ignores learner prose when creating
 * the reflection feedback, so it cannot be instruction-injected.
 */
export class LocalTemplateReviewGenerator implements ReviewCoachGenerator {
  async generate(request: Readonly<ReviewGenerationRequest>): Promise<ReviewGenerationResult> {
    const envelope = parseEnvelope(request.payload.prompt);
    const currentNumber = envelope.current_question?.number ?? 0;
    const outcome = envelope.selected_outcomes[currentNumber % envelope.selected_outcomes.length]!;
    const mode = envelope.allowed_modes[currentNumber % envelope.allowed_modes.length] ?? "free_recall";
    const text = envelope.operation === "ask_question"
      ? JSON.stringify({ kind: "question", question: questionFor(outcome, mode) })
      : JSON.stringify({
          kind: "feedback_and_question",
          feedback: {
            text: "Local self-check: identify one claim in your answer that directly demonstrates the cited outcome, then note one point to verify in the learner-visible README. This is a reflection prompt, not a correctness or mastery assessment.",
            outcome_ids: envelope.current_question?.outcome_ids ?? [outcome.outcome_id],
          },
          next_question: envelope.next_question_required ? questionFor(outcome, mode) : null,
        });
    const threadId = request.threadId ?? `local-review:${request.sessionId}`;
    const turnId = `local-turn:${randomUUID()}`;
    return {
      threadId,
      turnId,
      text,
      provenance: {
        engine: "local-template",
        transport: "in-process",
        model: null,
        permissionProfile: null,
        threadId,
        turnId,
        disclosureId: request.disclosure.disclosureId,
        payloadHash: request.disclosure.payloadHash,
        outputSchemaApplied: false,
      },
    };
  }
}
