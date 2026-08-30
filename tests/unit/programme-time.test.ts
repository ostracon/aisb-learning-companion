import { describe, expect, it } from "vitest";
import {
  fromProgrammeDateTimeLocal,
  toProgrammeDateTimeLocal,
} from "../../src/client/time/programme-time.js";

describe("programme date/time fields", () => {
  it("converts summer London wall time without using the host timezone", () => {
    expect(fromProgrammeDateTimeLocal("2026-08-31T18:00")).toBe("2026-08-31T17:00:00.000Z");
    expect(toProgrammeDateTimeLocal("2026-08-31T17:00:00.000Z")).toBe("2026-08-31T18:00");
  });

  it("converts winter London wall time", () => {
    expect(fromProgrammeDateTimeLocal("2026-12-01T18:00")).toBe("2026-12-01T18:00:00.000Z");
  });

  it("rejects an incomplete or skipped daylight-saving time", () => {
    expect(() => fromProgrammeDateTimeLocal("2026-08-31")).toThrow("complete date and time");
    expect(() => fromProgrammeDateTimeLocal("2026-03-29T01:30")).toThrow("does not exist");
  });
});
