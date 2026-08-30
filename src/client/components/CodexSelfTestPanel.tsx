import { useEffect, useRef, useState } from "react";

import type { CodexSelfTestResponse } from "../../shared/api.js";

export interface CodexSelfTestPanelProps {
  readonly fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const accountStatuses = new Set([
  "authenticated",
  "authentication_required",
  "not_configured",
  "unavailable",
]);
const accountKinds = new Set(["chatgpt", "api_key", "amazon_bedrock"]);
const issueCodes = new Set([
  "codex_process_unavailable",
  "codex_version_mismatch",
  "account_check_failed",
  "account_authentication_required",
  "model_catalog_unavailable",
  "required_model_unavailable",
  "required_effort_unavailable",
  "tutor_profile_unavailable",
  "review_profile_unavailable",
]);

function asSelfTest(value: unknown): CodexSelfTestResponse {
  if (
    !isRecord(value)
    || (value.status !== "ready" && value.status !== "degraded")
    || typeof value.tested_at !== "string"
    || !Number.isFinite(Date.parse(value.tested_at))
    || !isRecord(value.version)
    || typeof value.version.expected !== "string"
    || (value.version.reported !== null && typeof value.version.reported !== "string")
    || typeof value.version.matches !== "boolean"
    || !isRecord(value.account)
    || !accountStatuses.has(String(value.account.status))
    || (
      value.account.kind !== null
      && !accountKinds.has(String(value.account.kind))
    )
    || (value.account.plan !== null && typeof value.account.plan !== "string")
    || !isRecord(value.model)
    || value.model.model !== "gpt-5.6-sol"
    || typeof value.model.available !== "boolean"
    || typeof value.model.medium_effort_available !== "boolean"
    || !Array.isArray(value.profiles)
    || !Array.isArray(value.issues)
  ) {
    throw new Error("The Codex self-test returned malformed data");
  }
  for (const profile of value.profiles) {
    if (
      !isRecord(profile)
      || (profile.profile_id !== "aisb-tutor" && profile.profile_id !== "aisb-review")
      || typeof profile.applied !== "boolean"
      || typeof profile.instruction_source_verified !== "boolean"
    ) {
      throw new Error("The Codex self-test returned malformed profile data");
    }
  }
  for (const entry of value.issues) {
    if (
      !isRecord(entry)
      || !issueCodes.has(String(entry.code))
      || typeof entry.detail !== "string"
    ) {
      throw new Error("The Codex self-test returned malformed issue data");
    }
  }
  return value as unknown as CodexSelfTestResponse;
}

/** User-triggered, redacted verification of the local Codex integration. */
export function CodexSelfTestPanel({ fetch = globalThis.fetch }: CodexSelfTestPanelProps) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CodexSelfTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = async (): Promise<void> => {
    if (running) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/diagnostics/codex-self-test", {
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("The Codex self-test request failed");
      setResult(asSelfTest(await response.json()));
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "The Codex self-test request failed");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRunning(false);
      }
    }
  };

  return (
    <section className="codex-self-test" aria-labelledby="codex-self-test-title">
      <div className="codex-self-test-heading">
        <div>
          <h2 id="codex-self-test-title">Codex connection self-test</h2>
          <p>Checks the isolated account, GPT-5.6 Sol, and both restricted profiles. It does not send a tutor or review turn.</p>
        </div>
        <button type="button" className="secondary-button" disabled={running} onClick={() => void run()}>
          {running ? "Checking…" : result === null ? "Run self-test" : "Run again"}
        </button>
      </div>

      <div aria-live="polite">
        {running ? <p>Starting an isolated App Server and checking local capability…</p> : null}
        {error === null ? null : <p role="alert">{error}</p>}
        {result === null ? null : (
          <div className={`codex-self-test-result ${result.status}`}>
            <p><strong>{result.status === "ready" ? "Ready" : "Needs attention"}</strong></p>
            <dl className="diagnostic-list">
              <div><dt>Version</dt><dd>{result.version.reported ?? "Unavailable"}</dd></div>
              <div><dt>Account</dt><dd>{result.account.status}{result.account.plan === null ? "" : ` · ${result.account.plan}`}</dd></div>
              <div><dt>GPT-5.6 Sol</dt><dd>{result.model.available && result.model.medium_effort_available ? "Available · medium effort" : "Unavailable or incompatible"}</dd></div>
              {result.profiles.map((profile) => (
                <div key={profile.profile_id}>
                  <dt>{profile.profile_id}</dt>
                  <dd>{profile.applied && profile.instruction_source_verified ? "Applied · instructions verified" : "Could not verify"}</dd>
                </div>
              ))}
            </dl>
            {result.issues.length === 0 ? null : (
              <ul className="codex-self-test-issues">
                {result.issues.map((entry) => <li key={entry.code}>{entry.detail}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
