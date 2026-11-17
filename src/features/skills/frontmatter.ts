function lineEnd(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function withLineEnd(text: string, nl: "\r\n" | "\n"): string {
  return nl === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Deja el SKILL.md con el nombre del campo.
 *
 * El nombre de una skill vive en su frontmatter, así que editarlo en un campo aparte
 * significa escribirlo dentro del archivo. Si el usuario ya lo cambió a mano en el YAML,
 * el campo gana: es lo que tiene delante al apretar guardar.
 */
export function applyName(content: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return content;
  const nl = lineEnd(content);
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return withLineEnd(`---\nname: ${trimmed}\n---\n\n`, nl) + content;
  const withName = match[1].match(/^name:/m)
    ? match[1].replace(/^name:.*$/m, `name: ${trimmed}`)
    : `name: ${trimmed}\n${match[1]}`;
  return withLineEnd(`---\n${withName}\n---\n${normalized.slice(match[0].length)}`, nl);
}
