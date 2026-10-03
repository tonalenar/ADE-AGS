const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const DECORATIVE_CHARACTERS = /^[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2800-\u28FF]+$/;

export function sanitizePreviewLine(line: string): string {
  return line.replace(CONTROL_CHARACTERS, "");
}

export function isDecorativePreviewLine(line: string): boolean {
  const visible = line.replace(/\s/g, "");
  return visible.length > 0 && DECORATIVE_CHARACTERS.test(visible);
}

export function cleanPreviewLines(lines: string[]): string[] {
  return lines.map(sanitizePreviewLine).filter((line) => !isDecorativePreviewLine(line));
}
