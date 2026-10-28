/**
 * OSC 52: um programa do terminal pede que o terminal ponha texto na área de transferência (`ESC ] 52 ; c ; <base64> BEL`).
 * É assim que o OpenCode (e o tmux, o vim…) copia o que a pessoa selecionou com o mouse: eles mesmos capturam o mouse, então
 * a seleção do xterm não existe e, sem esta ponte, o texto nunca chegava ao Ctrl+V do sistema.
 *
 * Só ESCRITA. A leitura (`?`) devolveria o conteúdo da área de transferência a quem imprime no terminal: nunca.
 */

/** O teto do que se aceita copiar de uma vez. */
export const OSC52_MAX_BYTES = 1_000_000;

/** O texto a copiar de um `OSC 52`, ou `null` se é uma leitura, está vazio, está malformado ou passa do teto. Pura. */
export function decodeOsc52(data: string): string | null {
  const split = data.indexOf(";");
  if (split < 0) return null;
  const payload = data.slice(split + 1).trim();
  if (!payload || payload === "?") return null;
  if (payload.length > OSC52_MAX_BYTES * 1.4) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (bytes.length > OSC52_MAX_BYTES) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
