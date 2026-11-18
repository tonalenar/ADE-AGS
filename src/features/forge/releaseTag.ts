/** Tag de release que não vaza caminho no `.github/releases/`. */
export function isSafeReleaseTag(tag: string): boolean {
  const trimmed = tag.trim();
  if (!trimmed) return false;
  return !trimmed.includes("..") && !trimmed.includes("/") && !trimmed.includes("\\");
}
