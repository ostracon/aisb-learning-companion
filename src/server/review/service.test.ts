import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalOutcomeRecord } from "../../shared/page-context.js";
import {
  ReviewCoachService,
  ReviewCoachServiceError,
  type ReviewCoachGenerator,
  type ReviewDisclosureGrant,
  type ReviewDisclosurePreview,
  type ReviewGenerationRequest,
  type ReviewGenerationResult,
} from "./service.js";
import {
  FileReviewSessionStore,
  type ReviewSessionStorePort,
} from "./session-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const OUTCOME_ONE: CanonicalOutcomeRecord = Object.freeze({
  outcomeId: "1.1:security:0",
  outcomeVersionId: "outcome-version-1",
  sectionId: "1.1",
  category: "security",
  ordinal: 0,
  text: "Explain how a model-facing trust boundary changes an injection threat model.",
  sourcePath: "1.1-foundations/README.md",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
});

const OUTCOME_TWO: CanonicalOutcomeRecord = Object.freeze({
  outcomeId: "1.1:theory:0",
  outcomeVersionId: "outcome-version-2",
  sectionId: "1.1",
  category: "theory",
  ordinal: 0,
  text: "Compare two representations used in a simple AI system.",
  sourcePath: "1.1-foundations/README.md",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
});

class FakeGenerator implements ReviewCoachGenerator {
  readonly requests: ReviewGenerationRequest[] = [];
  readonly close = vi.fn();
  readonly #results: Array<ReviewGenerationResult | Error>;

  public constructor(...results: Array<ReviewGenerationResult | Error>) {
    this.#results = results;
  }

  public async generate(
    request: Readonly<ReviewGenerationRequest>,
  ): Promise<ReviewGenerationResult> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("No fake generation result queued");
    if (result instanceof Error) throw result;
    return {
      ...result,
      provenance: {
        ...result.provenance,
        disclosureId: request.disclosure.disclosureId,
        payloadHash: request.disclosure.payloadHash,
      },
    };
  }
}

interface RecoverableNativeReviewJournal {
  readonly turnsByClientMessageId: Map<string, ReviewGenerationResult>;
  dispatches: number;
  recoveries: number;
}

/**
 * Models the important kill point where Codex has durably completed a turn but
 * the companion process dies before it can publish the final session snapshot.
 */
class RecoverableCrashGenerator implements ReviewCoachGenerator {
  readonly requests: ReviewGenerationRequest[] = [];

  public constructor(
    private readonly journal: RecoverableNativeReviewJournal,
    private readonly result: ReviewGenerationResult,
    private readonly crashAfterDispatch: boolean,
  ) {}

  public async generate(
    request: Readonly<ReviewGenerationRequest>,
  ): Promise<ReviewGenerationResult> {
    this.requests.push(request);
    if (request.reconcileOnly) {
      this.journal.recoveries += 1;
      const recovered = this.journal.turnsByClientMessageId.get(
        request.disclosure.disclosureId,
      );
      if (recovered === undefined) throw new Error("No native turn available to recover");
      return recovered;
    }

    this.journal.dispatches += 1;
    const completed = {
      ...this.result,
      provenance: {
        ...this.result.provenance,
        disclosureId: request.disclosure.disclosureId,
        payloadHash: request.disclosure.payloadHash,
      },
    } satisfies ReviewGenerationResult;
    this.journal.turnsByClientMessageId.set(
      request.disclosure.disclosureId,
      completed,
    );
    if (this.crashAfterDispatch) {
      throw new Error("process connection lost after native completion");
    }
    return completed;
  }
}

function generation(text: unknown, turn = 1): ReviewGenerationResult {
  const turnId = `review-turn-${turn}`;
  return {
    threadId: "review-thread-1",
    turnId,
    text: typeof text === "string" ? text : JSON.stringify(text),
    provenance: {
      engine: "codex-app-server",
      transport: "turn/start",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-review",
      threadId: "review-thread-1",
      turnId,
      disclosureId: `disclosure-${turn}`,
      payloadHash: "filled-by-fake-generator",
      outputSchemaApplied: true,
    },
  };
}

function question(
  outcomeId = OUTCOME_ONE.outcomeId,
  prompt = "What changes at the model-facing trust boundary?",
  mode: "free_recall" | "compare_contrast" = "free_recall",
): object {
  return {
    kind: "question",
    question: {
      mode,
      prompt,
      outcome_ids: [outcomeId],
    },
  };
}

function feedback(input: {
  outcomeId?: string;
  nextQuestion?: object | null;
  extra?: Record<string, unknown>;
} = {}): object {
  return {
    kind: "feedback_and_question",
    feedback: {
      text: "You identified the untrusted boundary; now make the control explicit.",
      outcome_ids: [input.outcomeId ?? OUTCOME_ONE.outcomeId],
    },
    next_question: input.nextQuestion ?? null,
    ...input.extra,
  };
}

function deterministicIds(): (kind: string) => string {
  const counts = new Map<string, number>();
  return (kind) => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}-${count}`;
  };
}

function allowOnce(
  previews: ReviewDisclosurePreview[],
): (preview: Readonly<ReviewDisclosurePreview>) => Promise<ReviewDisclosureGrant> {
  return async (preview) => {
    previews.push(preview);
    return {
      decision: "allow_once",
      disclosureId: preview.disclosureId,
      payloadHash: preview.payloadHash,
    };
  };
}

function createService(
  generator: FakeGenerator,
  previews: ReviewDisclosurePreview[] = [],
  authorizeDisclosure: (
    preview: Readonly<ReviewDisclosurePreview>,
  ) => Promise<ReviewDisclosureGrant | null> = allowOnce(previews),
): ReviewCoachService {
  return new ReviewCoachService({
    generator,
    authorizeDisclosure,
    createId: deterministicIds(),
    now: () => new Date("2026-08-29T19:00:00.000Z"),
  });
}

function createPersistentService(
  generator: ReviewCoachGenerator,
  sessionStore: ReviewSessionStorePort,
  idNamespace: string,
): ReviewCoachService {
  const counts = new Map<string, number>();
  return new ReviewCoachService({
    generator,
    sessionStore,
    authorizeDisclosure: allowOnce([]),
    createId(kind) {
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      return `${kind}-${idNamespace}-${count}`;
    },
    now: () => new Date("2026-08-29T19:00:00.000Z"),
  });
}

describe("ReviewCoachService canonical sessions", () => {
  it("creates a local advisory session without disclosing or generating", async () => {
    const generator = new FakeGenerator();
    const authorizeDisclosure = vi.fn();
    const service = createService(generator, [], authorizeDisclosure);

    const session = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE, OUTCOME_TWO],
      questionLimit: 3,
      modes: ["free_recall", "compare_contrast"],
    });

    expect(session).toMatchObject({
      sessionId: "session-1",
      threadId: null,
      status: "ready_for_question",
      questionLimit: 3,
      questionsAsked: 0,
      responsesRecorded: 0,
      selectedOutcomeIds: [OUTCOME_ONE.outcomeId, OUTCOME_TWO.outcomeId],
      currentQuestion: null,
      assessmentAuthority: "advisory",
    });
    expect(authorizeDisclosure).not.toHaveBeenCalled();
    expect(generator.requests).toHaveLength(0);
  });

  it.each([
    "1.1-foundations/day1_answers.py",
    "1.1-foundations/exercise_solution.py",
    "1.1-foundations/exercise_test.py",
  ])("rejects a protected outcome source before authorization: %s", async (sourcePath) => {
    const generator = new FakeGenerator();
    const authorizeDisclosure = vi.fn();
    const service = createService(generator, [], authorizeDisclosure);

    await expect(
      service.createSession({
        canonicalOutcomes: [{ ...OUTCOME_ONE, sourcePath }],
      }),
    ).rejects.toThrowError(ReviewCoachServiceError);
    expect(authorizeDisclosure).not.toHaveBeenCalled();
    expect(generator.requests).toHaveLength(0);
  });

  it("rejects duplicate logical or version outcome identities", async () => {
    const service = createService(new FakeGenerator());

    await expect(
      service.createSession({
        canonicalOutcomes: [OUTCOME_ONE, { ...OUTCOME_TWO, outcomeId: OUTCOME_ONE.outcomeId }],
      }),
    ).rejects.toThrow(/must be unique/);
    await expect(
      service.createSession({
        canonicalOutcomes: [
          OUTCOME_ONE,
          { ...OUTCOME_TWO, outcomeVersionId: OUTCOME_ONE.outcomeVersionId },
        ],
      }),
    ).rejects.toThrow(/must be unique/);
  });
});

describe("ReviewCoachService authorized question flow", () => {
  it("pauses at an exact disclosure preview and derives canonical citations", async () => {
    const previews: ReviewDisclosurePreview[] = [];
    const generator = new FakeGenerator(generation(question()));
    const service = createService(generator, previews);
    const created = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 2,
      modes: ["free_recall"],
    });

    const session = await service.startQuestion({ sessionId: created.sessionId });

    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      sessionId: created.sessionId,
      operation: "question",
      includesLearnerResponse: false,
      selectedOutcomeIds: [OUTCOME_ONE.outcomeId],
      payloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(previews[0]?.payload.prompt).toContain(OUTCOME_ONE.text);
    expect(previews[0]?.payload.prompt).toContain('"recall_target_count":1');
    expect(previews[0]?.payload.prompt).toContain('"maximum_prompt_characters":320');
    expect(previews[0]?.payload.prompt).not.toContain("answers.py");
    expect(previews[0]?.payload.outputSchema).toMatchObject({ type: "object" });
    expect(generator.requests[0]?.disclosure).toMatchObject({ decision: "allow_once" });
    expect(session).toMatchObject({
      threadId: "review-thread-1",
      status: "awaiting_response",
      questionsAsked: 1,
      currentQuestion: {
        questionId: "question-1",
        number: 1,
        total: 2,
        mode: "free_recall",
        outcomeIds: [OUTCOME_ONE.outcomeId],
        citations: [
          {
            outcomeId: OUTCOME_ONE.outcomeId,
            outcomeVersionId: OUTCOME_ONE.outcomeVersionId,
            sourcePath: OUTCOME_ONE.sourcePath,
          },
        ],
      },
    });
    expect(session.currentQuestion?.provenance).toMatchObject({
      engine: "codex-app-server",
      transport: "turn/start",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-review",
      threadId: "review-thread-1",
      turnId: "review-turn-1",
      disclosureId: previews[0]?.disclosureId,
      payloadHash: previews[0]?.payloadHash,
      outputSchemaApplied: true,
    });
  });

  it("does not call the generator when the exact disclosure is denied", async () => {
    const generator = new FakeGenerator(generation(question()));
    const service = createService(generator, [], async () => null);
    const session = await service.createSession({ canonicalOutcomes: [OUTCOME_ONE] });

    await expect(service.startQuestion({ sessionId: session.sessionId })).rejects.toMatchObject({
      code: "disclosure_denied",
      statusCode: 409,
    });
    expect(generator.requests).toHaveLength(0);
    expect((await service.readSession(session.sessionId)).status).toBe("ready_for_question");
  });

  it("rejects unknown outcome links and schema additions without publishing a question", async () => {
    const unknownGenerator = new FakeGenerator(generation(question("1.1:security:99")));
    const unknownService = createService(unknownGenerator);
    const unknownSession = await unknownService.createSession({ canonicalOutcomes: [OUTCOME_ONE] });

    await expect(
      unknownService.startQuestion({ sessionId: unknownSession.sessionId }),
    ).rejects.toMatchObject({ code: "invalid_model_output" });
    expect((await unknownService.readSession(unknownSession.sessionId)).currentQuestion).toBeNull();

    const extraGenerator = new FakeGenerator(
      generation({ ...question(), mastery: "complete" }),
    );
    const extraService = createService(extraGenerator);
    const extraSession = await extraService.createSession({ canonicalOutcomes: [OUTCOME_ONE] });
    await expect(
      extraService.startQuestion({ sessionId: extraSession.sessionId }),
    ).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("rejects compound or overlong questions at the application boundary", async () => {
    const compoundService = createService(new FakeGenerator(generation({
      kind: "question",
      question: {
        mode: "free_recall",
        prompt: "Explain both outcomes.",
        outcome_ids: [OUTCOME_ONE.outcomeId, OUTCOME_TWO.outcomeId],
      },
    })));
    const compoundSession = await compoundService.createSession({
      canonicalOutcomes: [OUTCOME_ONE, OUTCOME_TWO],
    });
    await expect(compoundService.startQuestion({
      sessionId: compoundSession.sessionId,
    })).rejects.toMatchObject({ code: "invalid_model_output" });

    const overlongService = createService(new FakeGenerator(generation(question(
      OUTCOME_ONE.outcomeId,
      "x".repeat(321),
    ))));
    const overlongSession = await overlongService.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
    });
    await expect(overlongService.startQuestion({
      sessionId: overlongSession.sessionId,
    })).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("idempotently returns the one unanswered question when start is retried", async () => {
    const generator = new FakeGenerator(generation(question()));
    const service = createService(generator);
    const created = await service.createSession({ canonicalOutcomes: [OUTCOME_ONE] });
    const started = await service.startQuestion({ sessionId: created.sessionId });

    await expect(service.startQuestion({ sessionId: created.sessionId })).resolves.toEqual(started);
    expect(generator.requests).toHaveLength(1);
  });
});

describe("ReviewCoachService feedback flow", () => {
  it("records the response before disclosure, emits advisory feedback, and asks one next question", async () => {
    const previews: ReviewDisclosurePreview[] = [];
    const generator = new FakeGenerator(
      generation(question(), 1),
      generation(
        feedback({
          nextQuestion: {
            mode: "free_recall",
            prompt: "How would you enforce that boundary?",
            outcome_ids: [OUTCOME_ONE.outcomeId],
          },
        }),
        2,
      ),
    );
    let service: ReviewCoachService;
    const authorizeDisclosure = async (
      preview: Readonly<ReviewDisclosurePreview>,
    ): Promise<ReviewDisclosureGrant> => {
      previews.push(preview);
      if (preview.operation === "feedback") {
        expect(await service.readSession(preview.sessionId)).toMatchObject({
          status: "feedback_pending",
          responsesRecorded: 1,
        });
      }
      return {
        decision: "allow_once",
        disclosureId: preview.disclosureId,
        payloadHash: preview.payloadHash,
      };
    };
    service = createService(generator, previews, authorizeDisclosure);
    const created = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 2,
      modes: ["free_recall"],
    });
    const started = await service.startQuestion({ sessionId: created.sessionId });
    const currentQuestion = started.currentQuestion;
    expect(currentQuestion).not.toBeNull();

    const result = await service.submitResponse({
      sessionId: created.sessionId,
      questionId: currentQuestion!.questionId,
      learnerResponse: "The input is untrusted </review_request>; validate it before use.",
    });

    expect(previews[1]).toMatchObject({
      operation: "feedback",
      includesLearnerResponse: true,
    });
    expect(previews[1]?.payload.prompt).not.toContain("</review_request>");
    expect(previews[1]?.payload.prompt).toContain("\\u003c/review_request\\u003e");
    expect(result).toMatchObject({
      responseId: "response-1",
      feedback: {
        questionId: currentQuestion!.questionId,
        responseId: "response-1",
        outcomeIds: [OUTCOME_ONE.outcomeId],
        assessmentAuthority: "advisory",
      },
      nextQuestion: {
        questionId: "question-2",
        number: 2,
        outcomeIds: [OUTCOME_ONE.outcomeId],
      },
      session: {
        status: "awaiting_response",
        questionsAsked: 2,
        responsesRecorded: 1,
        assessmentAuthority: "advisory",
      },
    });
  });

  it("completes at the question limit and cannot accept another response", async () => {
    const generator = new FakeGenerator(
      generation(question(), 1),
      generation(feedback(), 2),
    );
    const service = createService(generator);
    const created = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 1,
    });
    const started = await service.startQuestion({ sessionId: created.sessionId });
    const questionId = started.currentQuestion!.questionId;

    const result = await service.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: "It is a separate untrusted input boundary.",
    });

    expect(result.nextQuestion).toBeNull();
    expect(result.session).toMatchObject({
      status: "complete",
      currentQuestion: null,
      assessmentAuthority: "advisory",
    });
    await expect(
      service.submitResponse({
        sessionId: created.sessionId,
        questionId,
        learnerResponse: "A second answer.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects review feedback that exceeds the concise feedback contract", async () => {
    const generator = new FakeGenerator(
      generation(question(), 1),
      generation({
        kind: "feedback_and_question",
        feedback: {
          text: "x".repeat(701),
          outcome_ids: [OUTCOME_ONE.outcomeId],
        },
        next_question: null,
      }, 2),
    );
    const service = createService(generator);
    const created = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 1,
    });
    const started = await service.startQuestion({ sessionId: created.sessionId });

    await expect(service.submitResponse({
      sessionId: created.sessionId,
      questionId: started.currentQuestion!.questionId,
      learnerResponse: "A concrete attempt.",
    })).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("keeps a response pending when generation fails and accepts only an exact retry", async () => {
    const generator = new FakeGenerator(
      generation(question(), 1),
      new Error("temporary generator failure"),
      generation(feedback(), 3),
    );
    const service = createService(generator);
    const created = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 1,
    });
    const started = await service.startQuestion({ sessionId: created.sessionId });
    const questionId = started.currentQuestion!.questionId;

    await expect(
      service.submitResponse({
        sessionId: created.sessionId,
        questionId,
        learnerResponse: "My recorded answer.",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await service.readSession(created.sessionId)).toMatchObject({
      status: "feedback_pending",
      responsesRecorded: 1,
    });
    await expect(
      service.submitResponse({
        sessionId: created.sessionId,
        questionId,
        learnerResponse: "A replacement answer.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const retry = await service.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: "My recorded answer.",
    });
    expect(retry.responseId).toBe("response-1");
    expect(retry.session.responsesRecorded).toBe(1);
  });

  it("rejects feedback linked outside the current question even when the outcome was selected", async () => {
    const generator = new FakeGenerator(
      generation(question(), 1),
      generation(feedback({ outcomeId: OUTCOME_TWO.outcomeId }), 2),
    );
    const service = createService(generator);
    const created = await service.createSession({
      canonicalOutcomes: [OUTCOME_ONE, OUTCOME_TWO],
      questionLimit: 1,
    });
    const started = await service.startQuestion({ sessionId: created.sessionId });

    await expect(
      service.submitResponse({
        sessionId: created.sessionId,
        questionId: started.currentQuestion!.questionId,
        learnerResponse: "A concrete attempt.",
      }),
    ).rejects.toMatchObject({ code: "invalid_model_output" });
    expect((await service.readSession(created.sessionId)).lastFeedback).toBeNull();
  });
});

describe("ReviewCoachService restart persistence", () => {
  it("reconciles the first completed question after restart once the session ID is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-first-turn-recovery-"));
    temporaryRoots.push(root);
    const journal: RecoverableNativeReviewJournal = {
      turnsByClientMessageId: new Map(),
      dispatches: 0,
      recoveries: 0,
    };
    const crashGenerator = new RecoverableCrashGenerator(
      journal,
      generation(question(), 1),
      true,
    );
    const crashStore = new FileReviewSessionStore(root);
    const crashService = createPersistentService(crashGenerator, crashStore, "first-crash");
    const created = await crashService.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 1,
    });

    await expect(crashService.startQuestion({
      sessionId: created.sessionId,
    })).rejects.toMatchObject({ code: "unavailable" });
    const afterKill = await crashStore.read(created.sessionId);
    expect(afterKill).toMatchObject({
      threadId: null,
      questionsAsked: 0,
      currentQuestion: null,
      pendingOperation: {
        operation: "question",
        disclosureId: "disclosure-first-crash-1",
        dispatchAttempted: true,
      },
    });
    expect(journal).toMatchObject({ dispatches: 1, recoveries: 0 });
    await crashService.close();

    const recoveryGenerator = new RecoverableCrashGenerator(
      journal,
      generation(question("unused"), 99),
      false,
    );
    const recoveryService = createPersistentService(
      recoveryGenerator,
      new FileReviewSessionStore(root),
      "first-recovery",
    );
    await expect(recoveryService.readSession(created.sessionId)).resolves.toMatchObject({
      sessionId: created.sessionId,
      status: "ready_for_question",
      currentQuestion: null,
    });
    const recovered = await recoveryService.startQuestion({ sessionId: created.sessionId });
    expect(recovered).toMatchObject({
      status: "awaiting_response",
      threadId: "review-thread-1",
      questionsAsked: 1,
      currentQuestion: { prompt: "What changes at the model-facing trust boundary?" },
    });
    expect(journal).toMatchObject({ dispatches: 1, recoveries: 1 });
    expect(recoveryGenerator.requests[0]).toMatchObject({
      threadId: null,
      reconcileOnly: true,
      disclosure: { disclosureId: "disclosure-first-crash-1" },
    });

    await expect(recoveryService.startQuestion({
      sessionId: created.sessionId,
    })).resolves.toEqual(recovered);
    expect(recoveryGenerator.requests).toHaveLength(1);
    await recoveryService.close();
  });

  it("restores active, feedback-pending, and completed state with exact retry identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-session-restart-"));
    temporaryRoots.push(root);

    const firstStore = new FileReviewSessionStore(root);
    const firstGenerator = new FakeGenerator(
      generation(question(OUTCOME_ONE.outcomeId, "Compare the trust boundaries.", "compare_contrast"), 1),
    );
    const firstService = createPersistentService(firstGenerator, firstStore, "first");
    const created = await firstService.createSession({
      canonicalOutcomes: [OUTCOME_ONE, OUTCOME_TWO],
      questionLimit: 1,
      modes: ["compare_contrast", "free_recall"],
    });
    const started = await firstService.startQuestion({ sessionId: created.sessionId });
    expect(started).toMatchObject({
      status: "awaiting_response",
      threadId: "review-thread-1",
      currentQuestion: {
        mode: "compare_contrast",
        prompt: "Compare the trust boundaries.",
      },
    });
    await firstService.close();

    const failedFeedbackGenerator = new FakeGenerator(new Error("temporary feedback failure"));
    const secondStore = new FileReviewSessionStore(root);
    const secondService = createPersistentService(
      failedFeedbackGenerator,
      secondStore,
      "second",
    );
    const restoredActive = await secondService.readSession(created.sessionId);
    expect(restoredActive).toMatchObject({
      status: "awaiting_response",
      threadId: "review-thread-1",
      selectedOutcomeIds: [OUTCOME_ONE.outcomeId, OUTCOME_TWO.outcomeId],
      currentQuestion: {
        questionId: started.currentQuestion?.questionId,
        mode: "compare_contrast",
      },
    });
    const questionId = restoredActive.currentQuestion!.questionId;
    await expect(secondService.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: "  My exact persisted recall answer.  ",
      learnerConfidence: 4,
    })).rejects.toMatchObject({ code: "unavailable" });
    expect(failedFeedbackGenerator.requests[0]).toMatchObject({
      sessionId: created.sessionId,
      threadId: "review-thread-1",
    });
    await secondService.close();

    const thirdStore = new FileReviewSessionStore(root);
    const successfulRetryGenerator = new FakeGenerator(generation(feedback(), 3));
    const thirdService = createPersistentService(
      successfulRetryGenerator,
      thirdStore,
      "third",
    );
    const restoredPending = await thirdService.readSession(created.sessionId);
    expect(restoredPending).toMatchObject({
      status: "feedback_pending",
      threadId: "review-thread-1",
      responsesRecorded: 1,
      lastLearnerConfidence: 4,
      pendingResponse: {
        questionId,
        learnerResponse: "  My exact persisted recall answer.  ",
        learnerConfidence: 4,
      },
    });
    const persistedPending = await thirdStore.read(created.sessionId);
    expect(persistedPending).toMatchObject({
      modes: ["compare_contrast", "free_recall"],
      pendingResponseId: "response-second-1",
      responses: [{
        responseId: "response-second-1",
        questionId,
        text: "  My exact persisted recall answer.  ",
        learnerConfidence: 4,
      }],
    });

    await expect(thirdService.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: "A replacement answer must not overwrite the recorded response.",
      learnerConfidence: 4,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(successfulRetryGenerator.requests).toHaveLength(0);

    const completed = await thirdService.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: "  My exact persisted recall answer.  ",
      learnerConfidence: 4,
    });
    expect(completed).toMatchObject({
      responseId: "response-second-1",
      session: {
        status: "complete",
        responsesRecorded: 1,
        threadId: "review-thread-1",
      },
      feedback: {
        responseId: "response-second-1",
        text: "You identified the untrusted boundary; now make the control explicit.",
      },
    });
    await thirdService.close();

    const finalService = createPersistentService(
      new FakeGenerator(),
      new FileReviewSessionStore(root),
      "final",
    );
    await expect(finalService.readSession(created.sessionId)).resolves.toMatchObject({
      status: "complete",
      threadId: "review-thread-1",
      responsesRecorded: 1,
      lastLearnerConfidence: 4,
      selectedOutcomeIds: [OUTCOME_ONE.outcomeId, OUTCOME_TWO.outcomeId],
      currentQuestion: null,
      lastFeedback: {
        responseId: "response-second-1",
        text: "You identified the untrusted boundary; now make the control explicit.",
      },
    });
    await finalService.close();
  });

  it("recovers a completed feedback turn after a kill point without dispatching it twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-completed-turn-recovery-"));
    temporaryRoots.push(root);

    const initialService = createPersistentService(
      new FakeGenerator(generation(question(), 1)),
      new FileReviewSessionStore(root),
      "initial",
    );
    const created = await initialService.createSession({
      canonicalOutcomes: [OUTCOME_ONE],
      questionLimit: 1,
    });
    const started = await initialService.startQuestion({ sessionId: created.sessionId });
    const questionId = started.currentQuestion!.questionId;
    await initialService.close();

    const journal: RecoverableNativeReviewJournal = {
      turnsByClientMessageId: new Map(),
      dispatches: 0,
      recoveries: 0,
    };
    const crashGenerator = new RecoverableCrashGenerator(
      journal,
      generation(feedback(), 2),
      true,
    );
    const crashStore = new FileReviewSessionStore(root);
    const crashService = createPersistentService(crashGenerator, crashStore, "crash");
    const exactAnswer = "My answer reached Codex exactly once.";

    await expect(crashService.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: exactAnswer,
      learnerConfidence: 3,
    })).rejects.toMatchObject({ code: "unavailable" });
    expect(journal).toMatchObject({ dispatches: 1, recoveries: 0 });
    const afterKill = await crashStore.read(created.sessionId);
    expect(afterKill).toMatchObject({
      pendingResponseId: "response-crash-1",
      pendingOperation: {
        operation: "feedback",
        disclosureId: "disclosure-crash-1",
        dispatchAttempted: true,
        payloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    await crashService.close();

    const recoveryGenerator = new RecoverableCrashGenerator(
      journal,
      generation(feedback(), 99),
      false,
    );
    const recoveryStore = new FileReviewSessionStore(root);
    const recoveryService = createPersistentService(
      recoveryGenerator,
      recoveryStore,
      "recovery",
    );
    const completed = await recoveryService.submitResponse({
      sessionId: created.sessionId,
      questionId,
      learnerResponse: exactAnswer,
      learnerConfidence: 3,
    });

    expect(completed.session.status).toBe("complete");
    expect(journal).toMatchObject({ dispatches: 1, recoveries: 1 });
    expect(recoveryGenerator.requests).toEqual([
      expect.objectContaining({
        reconcileOnly: true,
        disclosure: expect.objectContaining({
          disclosureId: "disclosure-crash-1",
        }),
      }),
    ]);
    expect(await recoveryStore.read(created.sessionId)).toMatchObject({
      pendingResponseId: null,
      pendingOperation: null,
      complete: true,
    });
    await recoveryService.close();
  });
});
