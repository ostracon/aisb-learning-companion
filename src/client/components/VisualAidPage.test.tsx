// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VisualAidPage } from "./VisualAidPage.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VisualAidPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("requires review before the separately confirmed provider call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({
        confirmationToken: "confirm-token",
        payloadHash: `sha256:${"a".repeat(64)}`,
        expiresAt: "2026-08-30T10:15:00.000Z",
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
        brief: {},
        renderedPrompt: "Create one clear educational visual.\nTitle: Trust boundary",
      }))
      .mockResolvedValueOnce(jsonResponse({
        assetId: "visual_12345678-1234-1234-1234-123456789abc",
        createdAt: "2026-08-30T10:02:00.000Z",
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
        mimeType: "image/png",
        byteLength: 8,
        contentHash: `sha256:${"b".repeat(64)}`,
        promptHash: `sha256:${"c".repeat(64)}`,
        brief: {
          title: "Trust boundary",
          pedagogicalPurpose: "Clarify a boundary",
          essentialRelationships: "Input to gate to tool",
          factualConstraints: "Gate owns authority",
          exclusions: "No answers",
          altText: "Three nodes separated by a gate",
          proseEquivalent: "The gate owns authority.",
        },
        imageUrl: "/api/visuals/visual_12345678-1234-1234-1234-123456789abc/image",
      }));
    const user = userEvent.setup();
    render(<MemoryRouter><VisualAidPage available /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe("/");

    await user.type(screen.getByLabelText("Title"), "Trust boundary");
    await user.type(screen.getByLabelText("Why would an image help?"), "Clarify a boundary");
    await user.type(screen.getByLabelText("Relationships to show"), "Input to gate to tool");
    await user.type(screen.getByLabelText("Facts it must preserve"), "Gate owns authority");
    await user.type(screen.getByLabelText("Alt text"), "Three nodes separated by a gate");
    await user.type(screen.getByLabelText("Equivalent explanation without the image"), "The gate owns authority.");
    await user.click(screen.getByRole("button", { name: "Review exact prompt" }));

    expect(await screen.findByText("Read what will be sent")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/visuals/preview");

    await user.click(screen.getByRole("button", { name: "Generate this visual" }));
    expect(await screen.findByText("Trust boundary", { selector: "h3" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/visuals/generate");
  });

  it("never offers generation when the backend key is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    render(<MemoryRouter><VisualAidPage available={false} /></MemoryRouter>);
    expect(screen.getByText(/Image generation is unavailable/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "Review exact prompt" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the newest assistant-prepared brief for learner review without generating", async () => {
    const preview = {
      confirmationToken: "confirm-token",
      payloadHash: `sha256:${"a".repeat(64)}`,
      expiresAt: "2026-08-30T22:15:00.000Z",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      brief: {
        title: "Model and policy gate",
        pedagogicalPurpose: "Clarify authority.",
        essentialRelationships: "Model output reaches a gate before tools.",
        factualConstraints: "The gate owns authority.",
        exclusions: "No answers.",
        altText: "A model, gate, and tool in a row.",
        proseEquivalent: "Only the gate authorises a tool.",
      },
      renderedPrompt: "Create one clear educational visual.\nTitle: Model and policy gate",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([preview]));

    render(<MemoryRouter><VisualAidPage available /></MemoryRouter>);

    expect(await screen.findByText(/assistant prepared this brief/i)).not.toBeNull();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Model and policy gate");
    expect(screen.getByText("Read what will be sent")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/visuals/generate")).toBe(false);
  });
});
