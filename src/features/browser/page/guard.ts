/**
 * A guarda semântica por elemento (achado O1 do plano v2): o snapshot guarda, por ref, uma IMPRESSÃO do que o elemento
 * era (papel, nome, valor, marcado, desabilitado, destino, texto do escopo). Antes de tocar, o runtime tira outra e, se
 * as duas diferem, o ref já não aponta para a mesma coisa: devolve `stale` SEM agir. Um framework que reaproveita nós
 * (React com chave por índice, uma lista que reordena) troca o produto de um cartão mantendo o `<button>`; `isConnected`
 * continua verdadeiro e o clique cairia no item errado.
 *
 * Aqui só a parte pura (comparar e descrever); tirar a impressão de um elemento precisa de `roleOf`/`nameOf` e vive em
 * `runtime.ts`.
 */

export interface Fingerprint {
  role: string;
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  /** O `href` como está escrito no elemento (vazio se não é um link). */
  href: string;
  /** O texto do `form`/`dialog`/`li`/`tr` mais próximo, sem dígitos: ver `scopeSignature`. */
  scope: string;
}

/** Um escopo maior que isso (um `<form>` que envolve a página inteira) não identifica nada e só daria falso «mudou». */
export const MAX_SCOPE_CHARS = 600;
const SCOPE_CLIP = 160;

/**
 * O texto do escopo, comparável: espaços colapsados e os números trocados por `#`. Uma quantidade, um preço ou um
 * contador que muda sozinho («2 itens» → «3 itens», «− 1 +» → «− 2 +») não é outro elemento; um produto que vira outro
 * («Teclado» → «Fone») é. Escopo grande demais → vazio.
 */
export function scopeSignature(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0 || flat.length > MAX_SCOPE_CHARS) return "";
  return flat.replace(/\d+(?:[.,]\d+)*/g, "#").slice(0, SCOPE_CLIP);
}

const LABELS: Record<keyof Fingerprint, string> = {
  role: "o tipo", name: "o nome", value: "o valor", checked: "o estado marcado", disabled: "o estado desabilitado",
  href: "o destino", scope: "o conteúdo em volta",
};
const ORDER: (keyof Fingerprint)[] = ["role", "name", "href", "scope", "value", "checked", "disabled"];

const show = (v: string | boolean): string => (typeof v === "boolean" ? String(v) : `"${v.length > 50 ? `${v.slice(0, 49)}…` : v}"`);

/** `null` = o mesmo elemento; senão, o que mudou, para a mensagem («o nome: "A" → "B"»). */
export function diffFingerprint(before: Fingerprint, now: Fingerprint): string | null {
  for (const key of ORDER) {
    if (before[key] !== now[key]) return `${LABELS[key]}: ${show(before[key])} → ${show(now[key])}`;
  }
  return null;
}

/** A recusa que o piloto entende («tire um novo snapshot» = relê e decide de novo, ver `jevPilot.ts`). */
export function staleMessage(ref: string, diff: string): string {
  return `stale: ${ref} mudou desde o último snapshot (${diff}). Não agi: tire um novo snapshot e escolha de novo.`;
}
