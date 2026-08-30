/** Server-only projection of one verified prepared reference for tutor context. */
export interface ScopedPreparedReferenceOrigin {
  readonly sectionId: string;
  readonly manifestRevision: string;
  readonly documentId: string;
  readonly documentContentHash: string;
  readonly label: string;
}

export interface ScopedPreparedReference {
  readonly sourceId: string;
  readonly title: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly fetchedAt: string;
  /** Hash of the immutable fetched source bytes. */
  readonly sourceContentHash: string;
  /** Hash of the exact inert Markdown projection below. */
  readonly projectionContentHash: string;
  readonly markdown: string;
  readonly truncated: boolean;
  /** Only origins intersecting the fresh server-resolved tutor scope. */
  readonly origins: readonly ScopedPreparedReferenceOrigin[];
}

export interface ScopedPreparedReferenceContextSource {
  readForSections(sectionIds: readonly string[]): Promise<readonly ScopedPreparedReference[]>;
}
