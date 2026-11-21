/**
 * Blindagem de abas preenchidas pelo cofre de logins (Tarefa A3).
 *
 * Mantém a lista de operações bloqueadas, a validação de URLs perigosas (`javascript:`, `data:`)
 * e a máscara de campos `input[type=password]` para `snapshot` e `describe`.
 */
import type { DescribedElement } from "./markedView";

export const VAULT_SHIELD_MESSAGE = "Esta aba tem uma senha do cofre preenchida. Peça ao usuário.";

/** Operações bloqueadas enquanto a aba permanecer na origem onde o cofre preencheu uma senha. */
export const SHIELDED_OPS: ReadonlySet<string> = new Set([
  "eval",
  "mock",
  "console",
  "storage",
  "network",
]);

const DANGEROUS_SCHEME = /^[\s\u0000-\u001f]*(javascript|data):/i;

/** Recusa navegação para `javascript:` e `data:` (evita execução de script na aba do agente). */
export function isDangerousNavigateUrl(url: string): boolean {
  return DANGEROUS_SCHEME.test(url);
}

/** Mascara valores `value="..."` para `••••` quando se trata de campo de senha. */
export function maskPasswordInText(text: string, isPasswordField: boolean): string {
  if (!isPasswordField) return text;
  return text.replace(/value="[^"]*"/g, 'value="••••"');
}

/** Garante que `describe` nunca devolva o valor literal de um `input[type=password]`. */
export function sanitizeDescribedPassword(el: DescribedElement): DescribedElement {
  const isPassword = el.tag.toLowerCase() === "input"
    && el.attributes?.type?.toLowerCase() === "password";
  if (!isPassword) return el;
  const attributes = { ...el.attributes };
  if ("value" in attributes && attributes.value) {
    attributes.value = "••••";
  }
  return {
    ...el,
    value: el.value ? "••••" : el.value,
    attributes,
    html: el.html ? maskPasswordInText(el.html, true) : el.html,
  };
}

/** Substitui ocorrências de segredos em `value="..."` de um snapshot por `value="••••"`. */
export function maskPasswordSecretsInSnapshot(snapshot: string, secrets: readonly string[]): string {
  let out = snapshot;
  for (const secret of secrets) {
    if (!secret) continue;
    const quoted = `value=${JSON.stringify(secret)}`;
    if (out.includes(quoted)) {
      out = out.split(quoted).join('value="••••"');
    }
  }
  return out;
}
