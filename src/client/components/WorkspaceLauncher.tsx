import { useMemo, useState } from "react";
import type {
  CurriculumSectionView,
  WorkspaceCreateResponse,
  WorkspaceLaunchResponse,
  WorkspaceLaunchToken,
  WorkspacePreviewRequest,
  WorkspacePreviewResponse,
} from "../../shared/api.js";
import { sectionTitleWithoutRepeatedId } from "../curriculum/section-label.js";

export interface WorkspaceLauncherProps {
  sections: readonly CurriculumSectionView[];
}

type LauncherState =
  | { kind: "idle" }
  | { kind: "preview"; value: WorkspacePreviewResponse }
  | { kind: "result"; value: WorkspaceLaunchResponse };

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The workspace handoff failed safely");
  return result;
}

export function WorkspaceLauncher({ sections }: WorkspaceLauncherProps) {
  const eligibleSections = useMemo(
    () => sections.filter((section) => section.participantTarget),
    [sections],
  );
  const [selectedSectionId, setSelectedSectionId] = useState(eligibleSections[0]?.sectionId ?? "");
  const [state, setState] = useState<LauncherState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedSection = eligibleSections.find((section) => section.sectionId === selectedSectionId)
    ?? eligibleSections[0];
  const target = selectedSection?.participantTarget;

  const preview = async () => {
    if (!selectedSection || !target || target.state === "blocked") return;
    setBusy(true);
    setError(null);
    try {
      const request: WorkspacePreviewRequest = {
        section_id: selectedSection.sectionId,
        expected_section_source_hash: target.sectionSourceHash,
        expected_declaration_hash: target.declarationHash,
        expected_starter_hash: target.starterHash,
      };
      setState({ kind: "preview", value: await postJson("/api/workspace/preview", request) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The workspace preview failed safely");
    } finally {
      setBusy(false);
    }
  };

  const launch = async (token: WorkspaceLaunchToken) => {
    setBusy(true);
    setError(null);
    try {
      setState({
        kind: "result",
        value: await postJson<WorkspaceLaunchResponse>("/api/workspace/launch", { token }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "VS Code could not be opened safely");
    } finally {
      setBusy(false);
    }
  };

  const createAndLaunch = async () => {
    if (state.kind !== "preview" || state.value.status !== "absent") return;
    setBusy(true);
    setError(null);
    try {
      const created = await postJson<WorkspaceCreateResponse>("/api/workspace/create", {
        token: state.value.create_token,
      });
      if (created.status === "already_existed") {
        setState({ kind: "idle" });
        setError("The answer file appeared after preview. Preview it again; it was not overwritten.");
        return;
      }
      setState({
        kind: "result",
        value: await postJson<WorkspaceLaunchResponse>("/api/workspace/launch", {
          token: created.launch_token,
        }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The participant file could not be created safely");
    } finally {
      setBusy(false);
    }
  };

  const previewValue = state.kind === "preview" ? state.value : null;
  const result = state.kind === "result" ? state.value : null;
  return (
    <div className="workspace-launcher">
      <div className="workspace-launcher-row">
        <label>
          <span className="sr-only">Curriculum section for VS Code</span>
          <select
            value={selectedSection?.sectionId ?? ""}
            disabled={eligibleSections.length === 0 || busy}
            onChange={(event) => {
              setSelectedSectionId(event.currentTarget.value);
              setState({ kind: "idle" });
              setError(null);
            }}
          >
            {eligibleSections.length === 0 ? <option value="">No declared answer file</option> : null}
            {eligibleSections.map((section) => (
              <option key={section.sectionId} value={section.sectionId}>
                {section.sectionId} · {sectionTitleWithoutRepeatedId(section.sectionId, section.title)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="outline-button"
          type="button"
          disabled={!target || target.state === "blocked" || busy}
          onClick={() => void preview()}
        >
          {busy ? "Checking…" : "Open in VS Code"}
        </button>
      </div>
      {target ? (
        <span className={`workspace-target ${target.state === "blocked" ? "blocked" : ""}`}>
          {target.relativePath} · {target.state === "file" ? "existing file" : target.state === "missing" ? "create if approved" : "blocked target"}
        </span>
      ) : (
        <span className="workspace-target">Choose a section with an explicitly declared participant answer file.</span>
      )}
      {previewValue ? (
        <div className="workspace-preview" role="status">
          <strong>{previewValue.status === "existing" ? "Existing learner file" : "Creation preview"}</strong>
          <p>
            {previewValue.status === "existing"
              ? `${previewValue.target_relative_path} will open byte-for-byte unchanged.`
              : `${previewValue.target_relative_path} does not exist. The starter below will be created without overwrite.`}
          </p>
          {previewValue.status === "absent" ? <pre>{previewValue.starter_content}</pre> : null}
          <div className="workspace-preview-actions">
            <button className="text-button" type="button" onClick={() => setState({ kind: "idle" })}>Cancel</button>
            {previewValue.status === "existing" ? (
              <button className="primary-button" type="button" disabled={busy} onClick={() => void launch(previewValue.launch_token)}>Open existing file</button>
            ) : (
              <button className="primary-button" type="button" disabled={busy} onClick={() => void createAndLaunch()}>Create &amp; open</button>
            )}
          </div>
        </div>
      ) : null}
      {result ? (
        <div className={`workspace-result ${result.status}`} role="status">
          {result.status === "opened" ? (
            <span>Opened {result.target_relative_path} in the AISB workspace.</span>
          ) : (
            <>
              <span>VS Code did not open. {result.created_by_service ? "The new answer file is safely preserved." : "The existing answer file was not changed."}</span>
              <code>{result.command.join(" ")}</code>
            </>
          )}
        </div>
      ) : null}
      {error ? <p className="workspace-launch-error" role="alert">{error}</p> : null}
    </div>
  );
}
