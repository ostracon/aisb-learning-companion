function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Avoid labels such as `4.1 · 4.1 — Model editing` when IDs are rendered separately. */
export function sectionTitleWithoutRepeatedId(sectionId: string, title: string): string {
  const prefix = new RegExp(
    `^${escapeRegularExpression(sectionId)}\\s*(?:[\\u2013\\u2014-]|:)\\s*`,
    "u",
  );
  return title.replace(prefix, "").trim() || title;
}
