import { describe, expect, it } from "vitest";
import { LocalTemplateReviewGenerator } from "./local-generator.js";

describe("LocalTemplateReviewGenerator", () => {
  it("creates one recall question from the frozen local outcome envelope", async () => {
    const generator = new LocalTemplateReviewGenerator();
    const result = await generator.generate({
      sessionId: "session-1",
      threadId: null,
      reconcileOnly: false,
      disclosure: { decision: "allow_once", disclosureId: "disclosure-1", payloadHash: `sha256:${"a".repeat(64)}` },
      payload: {
        prompt: `Header\n${JSON.stringify({
          operation: "ask_question",
          allowed_modes: ["explain_back"],
          selected_outcomes: [{ outcome_id: "1.1:security:1", text: "Explain the model boundary." }],
        })}`,
        outputSchema: {},
      },
    });
    expect(JSON.parse(result.text)).toEqual({
      kind: "question",
      question: {
        mode: "explain_back",
        prompt: "Explain one key idea from this outcome in your own words.",
        outcome_ids: ["1.1:security:1"],
      },
    });
    expect(result.threadId).toBe("local-review:session-1");
    expect(result.provenance).toMatchObject({
      engine: "local-template",
      transport: "in-process",
      model: null,
      permissionProfile: null,
      threadId: result.threadId,
      turnId: result.turnId,
      disclosureId: "disclosure-1",
      outputSchemaApplied: false,
    });
  });

  it("never echoes learner response text into local feedback", async () => {
    const generator = new LocalTemplateReviewGenerator();
    const canary = "DO_NOT_ECHO_LEARNER_CANARY";
    const result = await generator.generate({
      sessionId: "session-1",
      threadId: "local-review:session-1",
      reconcileOnly: false,
      disclosure: { decision: "allow_once", disclosureId: "disclosure-2", payloadHash: `sha256:${"b".repeat(64)}` },
      payload: {
        prompt: `Header\n${JSON.stringify({
          operation: "feedback_and_next_question",
          allowed_modes: ["free_recall"],
          selected_outcomes: [{ outcome_id: "1.1:security:1", text: "Explain the model boundary." }],
          current_question: { number: 1, outcome_ids: ["1.1:security:1"] },
          learner_response: { text: canary },
          next_question_required: false,
        })}`,
        outputSchema: {},
      },
    });
    expect(result.text).not.toContain(canary);
    expect(JSON.parse(result.text).next_question).toBeNull();
  });
});
