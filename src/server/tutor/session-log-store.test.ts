import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TutorSessionLogStore } from "./session-log-store.js";

const temporaryRoots: string[] = [];
const CONTEXT_HASH = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-tutor-sessions-test-"));
  temporaryRoots.push(root);
  return root;
}

function makeStore(stateRoot: string, startSecond = 0): TutorSessionLogStore {
  let tick = startSecond;
  return new TutorSessionLogStore(stateRoot, {
    now() {
      const date = new Date(Date.UTC(2026, 7, 29, 18, 0, tick));
      tick += 1;
      return date;
    },
  });
}

function logPath(stateRoot: string): string {
  return join(stateRoot, "tutor/sessions/sessions.jsonl");
}

const firstBinding = {
  scopeKey: "study:section:day1-1",
  chatId: "chat:learner-day1-1",
  threadId: "thread:codex-day1-1-a",
  model: "gpt-5.6-sol",
  permissionProfile: "aisb-tutor",
} as const;

function submission(turnNonce = "turn-nonce-1", text = "What distinguishes weights from activations?") {
  return {
    scopeKey: firstBinding.scopeKey,
    chatId: firstBinding.chatId,
    threadId: firstBinding.threadId,
    turnNonce,
    text,
    contextHash: CONTEXT_HASH,
  };
}

describe("TutorSessionLogStore durable learner-visible history", () => {
  it("reopens the append-only JSONL authority with exact ordered messages and recovery fields", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await store.recordSubmission(submission());
    await store.recordCompletion({
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      threadId: firstBinding.threadId,
      turnNonce: "turn-nonce-1",
      turnId: "codex-turn-1",
      text: "Weights are learned parameters; activations are values produced for an input.",
      citations: [
        {
          label: "1.1 README — Parameters and activations",
          url: "http://127.0.0.1:4173/study/day1/section/day1-1",
        },
      ],
    });
    await store.recordSubmission(submission("turn-nonce-2", "Can you give me one retrieval cue?"));
    await store.recordFailure({
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      threadId: firstBinding.threadId,
      turnNonce: "turn-nonce-2",
      safeCode: "TUTOR_TIMEOUT",
      text: "The tutor timed out. Your question is saved; retry when ready.",
    });
    await store.close();

    const reopened = makeStore(stateRoot, 20);
    const scope = await reopened.readScope(firstBinding.scopeKey);
    expect(scope).toMatchObject({
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      currentThreadId: firstBinding.threadId,
      currentModel: "gpt-5.6-sol",
      currentPermissionProfile: "aisb-tutor",
    });
    expect(scope?.messages.map((message) => [message.sequence, message.kind, message.role])).toEqual([
      [2, "submission", "learner"],
      [3, "completion", "tutor"],
      [4, "submission", "learner"],
      [5, "failure", "tutor"],
    ]);
    expect(scope?.messages[1]).toMatchObject({
      turnId: "codex-turn-1",
      citations: [
        {
          label: "1.1 README — Parameters and activations",
          url: "http://127.0.0.1:4173/study/day1/section/day1-1",
        },
      ],
    });
    expect(await reopened.readTurn(firstBinding.chatId, "turn-nonce-1")).toEqual({
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      threadId: firstBinding.threadId,
      turnNonce: "turn-nonce-1",
      learnerText: "What distinguishes weights from activations?",
      contextHash: CONTEXT_HASH,
      submittedAt: "2026-08-29T18:00:01.000Z",
      status: "completed",
      completion: {
        turnId: "codex-turn-1",
        assistantText: "Weights are learned parameters; activations are values produced for an input.",
        citations: [
          {
            label: "1.1 README — Parameters and activations",
            url: "http://127.0.0.1:4173/study/day1/section/day1-1",
          },
        ],
        completedAt: "2026-08-29T18:00:02.000Z",
      },
      failure: null,
    });
    expect(await reopened.readTurn(firstBinding.chatId, "turn-nonce-2")).toMatchObject({
      status: "failed",
      learnerText: "Can you give me one retrieval cue?",
      contextHash: CONTEXT_HASH,
      failure: { safeCode: "TUTOR_TIMEOUT" },
    });
    await reopened.close();
  });

  it("makes exact retries idempotent without appending duplicate records", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    expect((await store.bindScope(firstBinding)).status).toBe("bound");
    expect((await store.bindScope(firstBinding)).status).toBe("unchanged");
    expect((await store.recordSubmission(submission())).status).toBe("recorded");
    expect((await store.recordSubmission(submission())).status).toBe("unchanged");
    const completion = {
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      threadId: firstBinding.threadId,
      turnNonce: "turn-nonce-1",
      turnId: "codex-turn-1",
      text: "A concise answer.",
      citations: [{ label: "README", url: "https://example.test/readme" }],
    } as const;
    expect((await store.recordCompletion(completion)).status).toBe("recorded");
    expect((await store.recordCompletion(completion)).status).toBe("unchanged");
    await store.close();

    const lines = (await readFile(logPath(stateRoot), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("rejects conflicting submission and terminal retries", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await store.recordSubmission(submission());

    await expect(store.recordSubmission(submission("turn-nonce-1", "Different text"))).rejects.toMatchObject({
      code: "conflicting_duplicate",
    });
    await store.recordCompletion({
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      threadId: firstBinding.threadId,
      turnNonce: "turn-nonce-1",
      turnId: "codex-turn-1",
      text: "First answer",
    });
    await expect(
      store.recordCompletion({
        scopeKey: firstBinding.scopeKey,
        chatId: firstBinding.chatId,
        threadId: firstBinding.threadId,
        turnNonce: "turn-nonce-1",
        turnId: "codex-turn-1",
        text: "Changed answer",
      }),
    ).rejects.toMatchObject({ code: "conflicting_duplicate" });
    await expect(
      store.recordFailure({
        scopeKey: firstBinding.scopeKey,
        chatId: firstBinding.chatId,
        threadId: firstBinding.threadId,
        turnNonce: "turn-nonce-1",
        safeCode: "FAILED",
        text: "Contradictory terminal event",
      }),
    ).rejects.toMatchObject({ code: "conflicting_duplicate" });
    await store.close();
  });

  it("retains every thread segment when a scope is rebound", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    expect(
      (
        await store.bindScope({
          ...firstBinding,
          threadId: "thread:codex-day1-1-b",
        })
      ).status,
    ).toBe("rebound");
    expect(
      (
        await store.bindScope({
          ...firstBinding,
          threadId: "thread:codex-day1-1-a",
        })
      ).status,
    ).toBe("rebound");

    const scope = await store.readScope(firstBinding.scopeKey);
    expect(scope?.threadSegments.map((segment) => segment.threadId)).toEqual([
      "thread:codex-day1-1-a",
      "thread:codex-day1-1-b",
      "thread:codex-day1-1-a",
    ]);
    expect(scope?.currentThreadId).toBe("thread:codex-day1-1-a");
    await store.close();
  });

  it("lists bounded recent scope excerpts without manager self-history or provider metadata", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await store.recordSubmission(submission("turn-old", "Older learner question"));
    await store.recordCompletion({
      scopeKey: firstBinding.scopeKey,
      chatId: firstBinding.chatId,
      threadId: firstBinding.threadId,
      turnNonce: "turn-old",
      turnId: "codex-turn-old",
      text: "Older tutor reply",
      citations: [{ label: "Hidden from excerpt", url: "https://example.test/provider-detail" }],
    });
    const managerBinding = {
      scopeKey: "manager:overall",
      chatId: "manager-chat:overall",
      threadId: "manager-thread:overall",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-review",
    } as const;
    await store.bindScope(managerBinding);
    await store.recordSubmission({
      scopeKey: managerBinding.scopeKey,
      chatId: managerBinding.chatId,
      threadId: managerBinding.threadId,
      turnNonce: "manager-turn-one",
      text: "Manager self-history must never be injected.",
      contextHash: CONTEXT_HASH,
    });
    const recentBinding = {
      scopeKey: "today:day2:event-1",
      chatId: "chat:learner-day2",
      threadId: "thread:codex-day2",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-tutor",
    } as const;
    await store.bindScope(recentBinding);
    await store.recordSubmission({
      scopeKey: recentBinding.scopeKey,
      chatId: recentBinding.chatId,
      threadId: recentBinding.threadId,
      turnNonce: "turn-recent",
      text: "Name the boundary I should inspect first.",
      contextHash: CONTEXT_HASH,
    });
    await store.recordCompletion({
      scopeKey: recentBinding.scopeKey,
      chatId: recentBinding.chatId,
      threadId: recentBinding.threadId,
      turnNonce: "turn-recent",
      turnId: "codex-turn-recent",
      text: "Start with the transition from model output to the downstream action. ".repeat(5),
    });

    const listing = await store.listScopeExcerpts({
      maxScopes: 1,
      maxMessagesPerScope: 2,
      maxMessageBytes: 128,
      maxTotalBytes: 512,
      excludeScopeKeys: ["manager:overall"],
    });

    expect(listing.scopes).toHaveLength(1);
    expect(listing.scopes[0]).toMatchObject({
      scopeKey: recentBinding.scopeKey,
      messages: [
        { role: "learner", text: "Name the boundary I should inspect first.", truncated: false },
        { role: "tutor", truncated: true },
      ],
    });
    expect(listing.truncated).toBe(true);
    expect(listing.omittedScopeCount).toBe(1);
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toMatch(/manager self-history|manager-thread|thread:codex|gpt-5\.6|aisb-tutor|contextHash|provider-detail/u);
    await store.close();
  });

  it("enforces one chat per scope and one scope per chat", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await expect(
      store.bindScope({ ...firstBinding, chatId: "chat:different" }),
    ).rejects.toMatchObject({ code: "scope_chat_conflict" });
    await expect(
      store.bindScope({ ...firstBinding, scopeKey: "study:section:day1-2" }),
    ).rejects.toMatchObject({ code: "scope_chat_conflict" });
    expect(await store.readScope("study:section:day1-2")).toBeNull();
    await store.close();
  });

  it("serializes concurrent accepted submissions without losing either event", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await Promise.all([
      store.recordSubmission(submission("turn-concurrent-a", "Question A")),
      store.recordSubmission(submission("turn-concurrent-b", "Question B")),
    ]);
    const scope = await store.readScope(firstBinding.scopeKey);
    expect(scope?.messages.map((message) => message.text)).toEqual(["Question A", "Question B"]);
    await store.close();
  });

  it("drains an already accepted append before close completes", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    const pendingSubmission = store.recordSubmission(submission());
    const closing = store.close();
    await expect(pendingSubmission).resolves.toMatchObject({ status: "recorded" });
    await closing;

    const reopened = makeStore(stateRoot, 10);
    expect(await reopened.readTurn(firstBinding.chatId, "turn-nonce-1")).toMatchObject({
      status: "submitted",
      learnerText: "What distinguishes weights from activations?",
    });
    await reopened.close();
  });
});

describe("TutorSessionLogStore validation, recovery, and privacy", () => {
  it("rejects forbidden fields, malformed identifiers and hashes, and oversized content", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await expect(
      store.bindScope({ ...firstBinding, auth: { token: "do-not-store" } } as typeof firstBinding),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.bindScope({ ...firstBinding, threadId: "sk-proj-credential-canary" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await store.bindScope(firstBinding);
    await expect(
      store.recordSubmission({ ...submission(), contextHash: "not-a-hash" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.recordSubmission({ ...submission(), text: "x".repeat(256 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.recordSubmission({ ...submission(), text: "has\u0000nul" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.recordCompletion({
        scopeKey: firstBinding.scopeKey,
        chatId: firstBinding.chatId,
        threadId: firstBinding.threadId,
        turnNonce: "missing-submission",
        turnId: "codex-turn-bad-citation",
        text: "Unsafe citation",
        citations: [{ label: "local secret", url: "file:///private/secret" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.recordCompletion({
        scopeKey: firstBinding.scopeKey,
        chatId: firstBinding.chatId,
        threadId: firstBinding.threadId,
        turnNonce: "missing-submission",
        turnId: "codex-turn-missing",
        text: "Cannot be recorded first",
      }),
    ).rejects.toMatchObject({ code: "unknown_turn" });
    await store.close();

    const raw = await readFile(logPath(stateRoot), "utf8");
    expect(raw).not.toMatch(/do-not-store|credential-canary|not-a-hash|has\\u0000nul/);
    const onlyRecord = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(Object.keys(onlyRecord).sort()).toEqual([
      "chatId",
      "event",
      "model",
      "occurredAt",
      "permissionProfile",
      "schemaVersion",
      "scopeKey",
      "sequence",
      "threadId",
    ]);
  });

  it("recovers by discarding only a torn final JSONL record", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await store.recordSubmission(submission());
    await store.close();
    const acceptedBytes = await readFile(logPath(stateRoot));
    await appendFile(logPath(stateRoot), '{"schemaVersion":1,"sequence":3,"event":"completion"');

    const reopened = makeStore(stateRoot, 10);
    expect(await reopened.readTurn(firstBinding.chatId, "turn-nonce-1")).toMatchObject({
      status: "submitted",
      learnerText: "What distinguishes weights from activations?",
      contextHash: CONTEXT_HASH,
    });
    await reopened.close();
    expect(await readFile(logPath(stateRoot))).toEqual(acceptedBytes);
  });

  it("fails closed for malformed committed records instead of skipping history", async () => {
    const stateRoot = await temporaryStateRoot();
    const path = logPath(stateRoot);
    const first = makeStore(stateRoot);
    await first.close();
    await writeFile(path, '{"schemaVersion":1}\n', "utf8");
    const corrupt = makeStore(stateRoot);
    await expect(corrupt.readScope(firstBinding.scopeKey)).rejects.toMatchObject({
      code: "corrupt_store",
    });
    await expect(corrupt.close()).rejects.toMatchObject({ code: "corrupt_store" });
  });

  it("rejects symlinked tutor directories and log targets instead of following them", async () => {
    const linkedDirectoryRoot = await temporaryStateRoot();
    const outside = await temporaryStateRoot();
    await symlink(outside, join(linkedDirectoryRoot, "tutor"), "dir");
    const linkedDirectoryStore = makeStore(linkedDirectoryRoot);
    await expect(linkedDirectoryStore.readScope(firstBinding.scopeKey)).rejects.toMatchObject({
      code: "unsafe_path",
    });

    const linkedFileRoot = await temporaryStateRoot();
    await mkdir(join(linkedFileRoot, "tutor/sessions"), { recursive: true });
    const outsideLog = join(outside, "outside.jsonl");
    await writeFile(outsideLog, "", "utf8");
    await symlink(outsideLog, logPath(linkedFileRoot), "file");
    const linkedFileStore = makeStore(linkedFileRoot);
    await expect(linkedFileStore.readScope(firstBinding.scopeKey)).rejects.toMatchObject({
      code: "unsafe_path",
    });
    expect(await readFile(outsideLog, "utf8")).toBe("");
  });

  it("creates the learner history file with private permissions where POSIX modes apply", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.bindScope(firstBinding);
    await store.close();
    if (process.platform !== "win32") {
      expect((await stat(logPath(stateRoot))).mode & 0o777).toBe(0o600);
      expect((await stat(join(stateRoot, "tutor/sessions"))).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects an invalid injected timestamp before appending", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new TutorSessionLogStore(stateRoot, { now: () => new Date(Number.NaN) });
    await expect(store.bindScope(firstBinding)).rejects.toMatchObject({ code: "invalid_request" });
    await store.close();
    expect(await readFile(logPath(stateRoot), "utf8")).toBe("");
  });
});
