import { describe, expect, it } from "vitest";

import { createVerifiedRepositoryAdapter } from "./repository-adapter.js";

describe("verified AISB repository adapter", () => {
  it("is exported as a server-owned adapter factory", () => {
    expect(typeof createVerifiedRepositoryAdapter).toBe("function");
  });
});
