import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { VisualAidBrief } from "../../shared/visual.js";
import {
  VisualAidService,
  VisualAidServiceError,
  renderVisualPrompt,
  type VisualImageProvider,
} from "./service.js";

const brief: VisualAidBrief = {
  title: "A model gateway trust boundary",
  pedagogicalPurpose: "Show where untrusted model text crosses into privileged application actions.",
  essentialRelationships: "Learner input flows to the model; model output reaches a policy gate before tools.",
  factualConstraints: "The policy gate is application-owned and every tool call is separately authorised.",
  exclusions: "No solution code, vendor logos, people, screenshots, or decorative imagery.",
  altText: "A left-to-right flow with learner, model, policy gate, and tools separated by trust boundaries.",
  proseEquivalent: "Learner input is untrusted, model output remains untrusted, and only the policy gate can authorise a tool.",
};

function fakeProvider(bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])): VisualImageProvider {
  return { generate: vi.fn(async () => ({ bytes, mimeType: "image/png" as const })) };
}

describe("VisualAidService", () => {
  it("binds an exact reviewed brief to one immutable generated asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-"));
    const provider = fakeProvider();
    const service = new VisualAidService(root, provider, () => new Date("2026-08-30T10:00:00.000Z"));

    const preview = service.preview(brief);
    expect(preview.model).toBe("gpt-image-2");
    expect(preview.quality).toBe("low");
    expect(preview.renderedPrompt).toContain(brief.essentialRelationships);

    const asset = await service.generate({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    });
    expect(asset.brief).toEqual(brief);
    expect(asset.imageUrl).toBe(`/api/visuals/${asset.assetId}/image`);
    expect(provider.generate).toHaveBeenCalledOnce();
    expect(await service.list()).toEqual([asset]);
    expect((await service.readImage(asset.assetId)).bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    await expect(service.generate({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    })).rejects.toMatchObject({ code: "confirmation_expired" });
  });

  it("rejects mismatched and expired confirmations before a provider call", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-"));
    const provider = fakeProvider();
    let now = new Date("2026-08-30T10:00:00.000Z");
    const service = new VisualAidService(root, provider, () => now);
    const first = service.preview(brief);

    await expect(service.generate({
      confirmationToken: "different-token",
      payloadHash: first.payloadHash,
    })).rejects.toMatchObject({ code: "confirmation_mismatch" });
    expect(provider.generate).not.toHaveBeenCalled();

    now = new Date("2026-08-30T10:16:00.000Z");
    await expect(service.generate({
      confirmationToken: first.confirmationToken,
      payloadHash: first.payloadHash,
    })).rejects.toMatchObject({ code: "confirmation_expired" });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("fails closed when a saved asset no longer matches its metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-"));
    const service = new VisualAidService(root, fakeProvider());
    const preview = service.preview(brief);
    const asset = await service.generate({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    });
    await writeFile(join(root, "media", "visuals", asset.assetId, "image.png"), "changed");

    await expect(service.readImage(asset.assetId)).rejects.toMatchObject({
      code: "corrupt_store",
    });
  });

  it("never places prose-equivalent text or protected-answer language into the provider prompt", () => {
    const prompt = renderVisualPrompt(brief);
    expect(prompt).not.toContain(brief.proseEquivalent);
    expect(prompt).toContain("Do not introduce facts, answers, source code");
  });

  it("reports unavailable without creating a confirmation", () => {
    const service = new VisualAidService("/unused", null);
    expect(() => service.preview(brief)).toThrowError(VisualAidServiceError);
  });

  it("stores private JSON metadata without the provider credential surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-"));
    const service = new VisualAidService(root, fakeProvider());
    const preview = service.preview(brief);
    const asset = await service.generate({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    });
    const metadata = await readFile(
      join(root, "media", "visuals", asset.assetId, "metadata.json"),
      "utf8",
    );
    expect(metadata).not.toContain(preview.confirmationToken);
    expect(metadata).not.toContain("apiKey");
  });

  it("aborts an active provider call on pre-drain shutdown without retrying or publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-"));
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const provider: VisualImageProvider = {
      generate: vi.fn(async (_prompt, signal) => {
        providerStarted();
        return await new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }),
    };
    const service = new VisualAidService(root, provider);
    const preview = service.preview(brief);
    const active = service.generate({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    });
    await started;

    service.beginShutdown();
    service.beginShutdown();

    await expect(active).rejects.toMatchObject({
      code: "provider_failed",
      message: expect.stringMatching(/may have reached OpenAI and incurred usage/u),
    });
    expect(provider.generate).toHaveBeenCalledOnce();
    await expect(service.list()).resolves.toEqual([]);
    expect(() => service.preview(brief)).toThrowError(VisualAidServiceError);
  });

  it("refuses a symlinked media directory before calling the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-state-"));
    const outside = await mkdtemp(join(tmpdir(), "aisb-visuals-outside-"));
    await symlink(outside, join(root, "media"));
    const provider = fakeProvider();
    const service = new VisualAidService(root, provider);
    const preview = service.preview(brief);

    await expect(service.generate({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    })).rejects.toMatchObject({ code: "corrupt_store" });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it("selects the newest 200 valid assets rather than the first directory entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-visuals-"));
    const visualsRoot = join(root, "media", "visuals");
    await mkdir(visualsRoot, { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const ids = Array.from({ length: 201 }, (_, index) =>
      `visual_${index.toString(16).padStart(36, "0")}`);
    await Promise.all(ids.map(async (assetId, index) => {
      const assetRoot = join(visualsRoot, assetId);
      await mkdir(assetRoot);
      await Promise.all([
        writeFile(join(assetRoot, "image.png"), bytes),
        writeFile(join(assetRoot, "metadata.json"), `${JSON.stringify({
          schemaVersion: 1,
          assetId,
          createdAt: new Date(Date.UTC(2026, 7, 30, 10, 0, 0, index)).toISOString(),
          model: "gpt-image-2",
          size: "1024x1024",
          quality: "low",
          mimeType: "image/png",
          byteLength: bytes.byteLength,
          contentHash,
          promptHash: `sha256:${"0".repeat(64)}`,
          brief,
        })}\n`),
      ]);
    }));
    const service = new VisualAidService(root, fakeProvider());

    const assets = await service.list();

    expect(assets).toHaveLength(200);
    expect(assets[0]?.assetId).toBe(ids[200]);
    expect(assets.at(-1)?.assetId).toBe(ids[1]);
    expect(assets.some(({ assetId }) => assetId === ids[0])).toBe(false);
  });
});
