import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { BackupEnvelope } from "../../shared/backup.js";
import { registerBackupRoutes } from "./routes.js";
import { BackupExportError } from "./service.js";

describe("backup routes", () => {
  it("exports only after an explicit POST and marks the response private", async () => {
    const exportBackup = vi.fn(async () => ({
      schemaVersion: 1,
      format: "aisb-learning-companion-backup",
      manifest: {},
      manifestSha256: "sha256:test",
      files: [],
    }) as unknown as BackupEnvelope);
    const app = Fastify();
    registerBackupRoutes(app, { export: exportBackup });

    const missing = await app.inject({ method: "GET", url: "/api/backup/export" });
    expect(missing.statusCode).toBe(404);
    expect(exportBackup).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/backup/export",
      payload: { browserRecovery: { schemaVersion: 1 } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(exportBackup).toHaveBeenCalledOnce();
    await app.close();
  });

  it("maps expected fail-closed errors without exposing unexpected details", async () => {
    const app = Fastify();
    registerBackupRoutes(app, {
      async export() {
        throw new BackupExportError("credential_detected", "Credential-like bytes detected");
      },
    });
    const expected = await app.inject({ method: "POST", url: "/api/backup/export", payload: {} });
    expect(expected.statusCode).toBe(409);
    expect(expected.json()).toEqual({
      error: "Credential-like bytes detected",
      code: "credential_detected",
    });
    await app.close();

    const unexpectedApp = Fastify();
    registerBackupRoutes(unexpectedApp, {
      async export() {
        throw new Error("sensitive internal detail");
      },
    });
    const unexpected = await unexpectedApp.inject({
      method: "POST",
      url: "/api/backup/export",
      payload: {},
    });
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toEqual({
      error: "The local backup could not be created safely.",
    });
    await unexpectedApp.close();
  });
});
