import type { CurriculumService } from "../curriculum/service.js";
import type { CurriculumMaterialManifest, CurriculumMaterialService } from "../materials/service.js";
import type { PreparationManifestSource } from "./service.js";

/**
 * Reads only manifests derived from the current verified AISB checkout. External
 * URLs have already passed the material service's HTTPS-only link classifier.
 */
export class CurriculumPreparationManifestSource implements PreparationManifestSource {
  public constructor(
    private readonly curriculum: CurriculumService,
    private readonly materials: CurriculumMaterialService,
  ) {}

  public async readManifests(): Promise<readonly CurriculumMaterialManifest[]> {
    const days = await this.curriculum.readAllRepositoryDays();
    const sectionIds = [...new Set(
      Object.values(days)
        .flatMap((sections) => sections ?? [])
        .map(({ sectionId }) => sectionId),
    )].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    // Local manifest construction is intentionally sequential and bounded by
    // the verified curriculum hierarchy, avoiding a burst of filesystem work.
    const manifests: CurriculumMaterialManifest[] = [];
    for (const sectionId of sectionIds.slice(0, 256)) {
      manifests.push(await this.materials.manifest(sectionId));
    }
    return Object.freeze(manifests);
  }
}

