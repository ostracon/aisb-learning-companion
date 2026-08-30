import type { FastifyInstance, FastifyReply } from "fastify";

import type { BackupEnvelope } from "../../shared/backup.js";
import { BackupExportError } from "./service.js";

export interface BackupRouteService {
  export(input: unknown): Promise<BackupEnvelope>;
}

/** Register an explicit, read-only export action. No backup runs on page load. */
export function registerBackupRoutes(app: FastifyInstance, service: BackupRouteService): void {
  app.post("/api/backup/export", async (request, reply) => {
    try {
      const envelope = await service.export(request.body);
      return reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(envelope);
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });
}

function sendBackupError(reply: FastifyReply, error: unknown) {
  if (error instanceof BackupExportError) {
    const status = error.code === "invalid_request"
      ? 400
      : error.code === "size_limit"
        ? 413
        : error.code === "state_unavailable"
          ? 503
          : error.code === "corrupt_export"
            ? 500
            : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  return reply.code(500).send({ error: "The local backup could not be created safely." });
}
