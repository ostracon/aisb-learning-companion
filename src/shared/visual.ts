export const VISUAL_MODEL = "gpt-image-2" as const;

export interface VisualAidBrief {
  readonly title: string;
  readonly pedagogicalPurpose: string;
  readonly essentialRelationships: string;
  readonly factualConstraints: string;
  readonly exclusions: string;
  readonly altText: string;
  readonly proseEquivalent: string;
}

export interface VisualAidPreviewResponse {
  readonly confirmationToken: string;
  readonly payloadHash: string;
  readonly expiresAt: string;
  readonly model: typeof VISUAL_MODEL;
  readonly size: "1024x1024";
  readonly quality: "low";
  readonly brief: VisualAidBrief;
  readonly renderedPrompt: string;
}

export interface VisualAidAssetView {
  readonly assetId: string;
  readonly createdAt: string;
  readonly model: typeof VISUAL_MODEL;
  readonly size: "1024x1024";
  readonly quality: "low";
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly contentHash: string;
  readonly promptHash: string;
  readonly brief: VisualAidBrief;
  readonly imageUrl: string;
}

export interface GenerateVisualAidRequest {
  readonly confirmationToken: string;
  readonly payloadHash: string;
}
