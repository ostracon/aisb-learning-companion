import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CodexSelfTestIssueCode,
  CodexSelfTestProfileView,
  CodexSelfTestResponse,
} from "../../shared/api.js";
import type { Model } from "../codex/generated/v2/Model.js";
import type { GetAccountResponse } from "../codex/generated/v2/GetAccountResponse.js";
import {
  AppServerClient,
  type AppServerIdentity,
} from "../codex/app-server-client.js";
import {
  ensureTutorCodexHome,
  ensureReviewCodexWorkspace,
  REVIEW_PERMISSION_PROFILE,
  TUTOR_PERMISSION_PROFILE,
} from "../codex/runtime-profile.js";
import { TutorGateway } from "../codex/tutor-gateway.js";
import { sanitizedChildEnvironment, type RuntimeConfig } from "../config.js";

export const PINNED_CODEX_VERSION = "0.151.0";
export const REQUIRED_CODEX_MODEL = "gpt-5.6-sol" as const;

export interface CodexSelfTestRuntime {
  identity(): AppServerIdentity;
  readAccount(): Promise<GetAccountResponse>;
  listModels(): Promise<readonly Model[]>;
  verifyProfile(
    profileId: typeof TUTOR_PERMISSION_PROFILE | typeof REVIEW_PERMISSION_PROFILE,
  ): Promise<void>;
  close(): void;
}

export interface CodexSelfTestDependencies {
  readonly connect?: () => Promise<CodexSelfTestRuntime>;
  readonly now?: () => Date;
}

type Issue = CodexSelfTestResponse["issues"][number];

function issue(code: CodexSelfTestIssueCode, detail: string): Issue {
  return Object.freeze({ code, detail });
}

function accountProjection(response: GetAccountResponse): CodexSelfTestResponse["account"] {
  if (response.account === null) {
    return Object.freeze({
      status: response.requiresOpenaiAuth ? "authentication_required" : "not_configured",
      kind: null,
      plan: null,
    });
  }
  if (response.account.type === "chatgpt") {
    return Object.freeze({
      status: "authenticated",
      kind: "chatgpt",
      plan: String(response.account.planType),
    });
  }
  return Object.freeze({
    status: "authenticated",
    kind: response.account.type === "apiKey" ? "api_key" : "amazon_bedrock",
    plan: null,
  });
}

function reportedVersion(identity: AppServerIdentity): string | null {
  // App Server prefixes the server version with the connecting client's name
  // (for example `aisb-learning-companion/x.y.z (...)`). Older builds used
  // `Codex Desktop/x.y.z` or `codex-cli/x.y.z`. In every reviewed shape the
  // first product/version pair carries the App Server version; the client
  // metadata appears later in parentheses.
  return identity.userAgent.match(
    /^[^/\r\n]+\/([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u,
  )?.[1] ?? null;
}

export class CodexSelfTestService {
  readonly #connect: () => Promise<CodexSelfTestRuntime>;
  readonly #now: () => Date;

  public constructor(
    private readonly config: RuntimeConfig,
    dependencies: CodexSelfTestDependencies = {},
  ) {
    this.#connect = dependencies.connect ?? (() => connectLiveRuntime(config));
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async run(): Promise<CodexSelfTestResponse> {
    const testedAt = this.#now().toISOString();
    let runtime: CodexSelfTestRuntime;
    try {
      runtime = await this.#connect();
    } catch {
      return degradedUnavailable(testedAt);
    }

    const issues: Issue[] = [];
    let reported: string | null = null;
    try {
      reported = reportedVersion(runtime.identity());
    } catch {
      // The initialized identity is deliberately a tiny projection. Treat an
      // unavailable projection exactly like an unparseable version.
    }
    const versionMatches = reported === PINNED_CODEX_VERSION;
    if (!versionMatches) {
      issues.push(issue(
        "codex_version_mismatch",
        "The running App Server does not match the companion's reviewed pinned version.",
      ));
    }

    let account: CodexSelfTestResponse["account"] = {
      status: "unavailable",
      kind: null,
      plan: null,
    };
    try {
      account = accountProjection(await runtime.readAccount());
      if (account.status !== "authenticated") {
        issues.push(issue(
          "account_authentication_required",
          "The isolated companion Codex home does not currently have a usable account.",
        ));
      }
    } catch {
      issues.push(issue(
        "account_check_failed",
        "Codex account state could not be checked without exposing account details.",
      ));
    }

    let models: readonly Model[] = [];
    try {
      models = await runtime.listModels();
    } catch {
      issues.push(issue(
        "model_catalog_unavailable",
        "The Codex model catalog could not be read.",
      ));
    }
    const requiredModel = models.find((model) => model.model === REQUIRED_CODEX_MODEL);
    const modelAvailable = requiredModel !== undefined && !requiredModel.hidden;
    const mediumEffortAvailable = requiredModel?.supportedReasoningEfforts.some(
      ({ reasoningEffort }) => reasoningEffort === "medium",
    ) ?? false;
    if (!modelAvailable) {
      issues.push(issue(
        "required_model_unavailable",
        "GPT-5.6 Sol is not available to the isolated companion account.",
      ));
    } else if (!mediumEffortAvailable) {
      issues.push(issue(
        "required_effort_unavailable",
        "GPT-5.6 Sol does not advertise the companion's required medium reasoning effort.",
      ));
    }

    const profiles: CodexSelfTestProfileView[] = [];
    for (const profileId of [TUTOR_PERMISSION_PROFILE, REVIEW_PERMISSION_PROFILE] as const) {
      let applied = false;
      try {
        await runtime.verifyProfile(profileId);
        applied = true;
      } catch {
        issues.push(issue(
          profileId === TUTOR_PERMISSION_PROFILE
            ? "tutor_profile_unavailable"
            : "review_profile_unavailable",
          profileId === TUTOR_PERMISSION_PROFILE
            ? "The restricted tutor profile or AISB instruction source could not be verified."
            : "The restricted review profile or AISB instruction source could not be verified.",
        ));
      }
      profiles.push(Object.freeze({
        profile_id: profileId,
        applied,
        instruction_source_verified: applied,
      }));
    }

    try {
      return Object.freeze({
        status: issues.length === 0 ? "ready" : "degraded",
        tested_at: testedAt,
        version: Object.freeze({
          expected: PINNED_CODEX_VERSION,
          reported,
          matches: versionMatches,
        }),
        account: Object.freeze({ ...account }),
        model: Object.freeze({
          model: REQUIRED_CODEX_MODEL,
          available: modelAvailable,
          medium_effort_available: mediumEffortAvailable,
        }),
        profiles: Object.freeze(profiles),
        issues: Object.freeze(issues),
      });
    } finally {
      // A self-test owns its isolated App Server process. Never leave it alive
      // after rendering the bounded, redacted result.
      try {
        runtime.close();
      } catch {
        // Diagnostics cleanup must not replace the useful check result.
      }
    }
  }
}

function degradedUnavailable(testedAt: string): CodexSelfTestResponse {
  return Object.freeze({
    status: "degraded",
    tested_at: testedAt,
    version: Object.freeze({
      expected: PINNED_CODEX_VERSION,
      reported: null,
      matches: false,
    }),
    account: Object.freeze({ status: "unavailable", kind: null, plan: null }),
    model: Object.freeze({
      model: REQUIRED_CODEX_MODEL,
      available: false,
      medium_effort_available: false,
    }),
    profiles: Object.freeze([
      Object.freeze({
        profile_id: TUTOR_PERMISSION_PROFILE,
        applied: false,
        instruction_source_verified: false,
      }),
      Object.freeze({
        profile_id: REVIEW_PERMISSION_PROFILE,
        applied: false,
        instruction_source_verified: false,
      }),
    ]),
    issues: Object.freeze([
      issue(
        "codex_process_unavailable",
        "The isolated Codex App Server could not be started. No model turn was sent.",
      ),
    ]),
  });
}

async function connectLiveRuntime(config: RuntimeConfig): Promise<CodexSelfTestRuntime> {
  const [codexHome, reviewWorkspace, tutorInstructions, reviewInstructions] = await Promise.all([
    ensureTutorCodexHome({
      companionRoot: config.companionRoot,
      aisbRoot: config.aisbRoot,
      stateRoot: config.stateRoot,
    }),
    ensureReviewCodexWorkspace({ aisbRoot: config.aisbRoot }),
    readFile(join(config.companionRoot, "config", "developer-prompt.md"), "utf8"),
    readFile(
      join(config.companionRoot, "config", "prompts", "review", "developer-prompt.md"),
      "utf8",
    ),
  ]);
  const client = await AppServerClient.connect({
    executable: config.codexExecutable,
    cwd: config.aisbRoot,
    env: sanitizedChildEnvironment(process.env, { CODEX_HOME: codexHome.path }),
  });
  const instructions = new Map([
    [TUTOR_PERMISSION_PROFILE, tutorInstructions],
    [REVIEW_PERMISSION_PROFILE, reviewInstructions],
  ] as const);
  return Object.freeze({
    identity: () => client.identity(),
    readAccount: () => client.readAccount({ refreshToken: false }),
    listModels: () => new TutorGateway(client, {
      aisbRoot: config.aisbRoot,
      permissionsProfile: TUTOR_PERMISSION_PROFILE,
    }).listModels(),
    async verifyProfile(
      profileId: typeof TUTOR_PERMISSION_PROFILE | typeof REVIEW_PERMISSION_PROFILE,
    ) {
      const developerInstructions = instructions.get(profileId);
      if (developerInstructions === undefined) {
        throw new Error("The requested diagnostic profile has no reviewed prompt");
      }
      const gateway = new TutorGateway(client, {
        aisbRoot:
          profileId === REVIEW_PERMISSION_PROFILE
            ? reviewWorkspace.path
            : config.aisbRoot,
        permissionsProfile: profileId,
        developerInstructions,
        defaultModel: REQUIRED_CODEX_MODEL,
        defaultEffort: "medium",
      });
      await gateway.startThread({ ephemeral: true });
    },
    close: () => client.close(),
  });
}
