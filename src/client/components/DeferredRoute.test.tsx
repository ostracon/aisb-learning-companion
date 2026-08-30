// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { lazy } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeferredRoute } from "./DeferredRoute.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenRoute(): never {
  throw new Error("chunk unavailable");
}

describe("DeferredRoute", () => {
  it("shows a bounded loading state until the route module is ready", async () => {
    const LoadedRoute = () => <h1>Deferred page</h1>;
    let resolveRoute!: (value: { default: typeof LoadedRoute }) => void;
    const routeModule = new Promise<{ default: typeof LoadedRoute }>((resolve) => { resolveRoute = resolve; });
    const LazyRoute = lazy(() => routeModule);
    render(
      <MemoryRouter>
        <DeferredRoute><LazyRoute /></DeferredRoute>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toBe("Opening this notebook page…");
    await act(async () => resolveRoute({ default: LoadedRoute }));
    expect(await screen.findByRole("heading", { name: "Deferred page" })).toBeTruthy();
  });

  it("offers explicit recovery when a route chunk cannot load", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <DeferredRoute><BrokenRoute /></DeferredRoute>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "This page could not load." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Return to the notebook" }).getAttribute("href")).toBe("/");
    expect(consoleError).toHaveBeenCalled();
  });
});
