export const learningOutcomesDisclosurePreferenceKey =
  "aisb-companion:learning-outcomes-disclosure:v1";

interface LearningOutcomesDisclosurePreference {
  readonly version: 1;
  readonly expanded: boolean;
}

export function normalizeLearningOutcomesDisclosurePreference(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const candidate = value as Partial<LearningOutcomesDisclosurePreference>;
  return candidate.version === 1 && typeof candidate.expanded === "boolean"
    ? candidate.expanded
    : true;
}

export function serializeLearningOutcomesDisclosurePreference(expanded: boolean): string {
  return JSON.stringify({ version: 1, expanded } satisfies LearningOutcomesDisclosurePreference);
}
