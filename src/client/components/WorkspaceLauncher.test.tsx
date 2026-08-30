// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurriculumSectionView, WorkspaceLaunchToken } from "../../shared/api.js";
import { WorkspaceLauncher } from "./WorkspaceLauncher.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const section: CurriculumSectionView = {
  sectionId: "1.1",
  title: "LLM internals",
  sourcePath: "1.1-llm-internals/README.md",
  outcomes: [],
  participantTarget: {
    relativePath: "1.1-llm-internals/day1_answers.py",
    declaredByPath: "1.1-llm-internals/section1_instructions.md",
    declarationHash: "a".repeat(64),
    sectionSourceHash: "b".repeat(64),
    starterHash: "c".repeat(64),
    cursorLine: 5,
    state: "missing",
  },
};

const launchToken: WorkspaceLaunchToken = {
  kind: "workspace-launch-v1",
  token_id: "workspace-token-1234",
  section_id: "1.1",
  target_relative_path: "1.1-llm-internals/day1_answers.py",
  content_hash: "d".repeat(64),
  cursor_line: 5,
  created_by_service: false,
};

describe("WorkspaceLauncher", () => {
  it("previews the exact server-projected participant target before opening", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "existing",
        target_relative_path: section.participantTarget!.relativePath,
        launch_token: launchToken,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<WorkspaceLauncher sections={[section]} />);

    await user.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workspace/preview");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      section_id: "1.1",
      expected_section_source_hash: "b".repeat(64),
      expected_declaration_hash: "a".repeat(64),
      expected_starter_hash: "c".repeat(64),
    });
    expect(screen.getByText(/will open byte-for-byte unchanged/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open existing file" })).toBeTruthy();
  });

  it("stays disabled when no section has an unambiguous declared answer file", () => {
    const { participantTarget: _participantTarget, ...sectionWithoutTarget } = section;
    render(<WorkspaceLauncher sections={[sectionWithoutTarget]} />);
    expect((screen.getByRole("button", { name: "Open in VS Code" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/explicitly declared participant answer file/)).toBeTruthy();
  });
});
