import type { CSSProperties } from "react";

import type { AgentAccount } from "@/features/accounts/types";

/**
 * Identidade visual de uma conta: selo de iniciais e cor.
 *
 * A cor é o NOME de um token do tema (`green`), guardado no banco; nunca um hex. Os valores
 * são escritos por extenso (e não montados com template) para o Tailwind detectar cada
 * `var(--color-…)` no código e emitir a variável. A lista tem de casar com `ACCENT_TOKENS`
 * em `src-tauri/src/accounts/identity.rs`.
 *
 * O fundo usa o degrau 700 de cada matiz: em todos eles o texto claro (`gray-50`) passa de
 * 4,5:1, então o contraste não depende de cálculo em tempo de execução.
 */
export const ACCOUNT_COLORS = [
  { token: "blue", background: "var(--color-blue-700)", foreground: "var(--color-gray-50)" },
  { token: "violet", background: "var(--color-violet-700)", foreground: "var(--color-gray-50)" },
  { token: "orange", background: "var(--color-orange-700)", foreground: "var(--color-gray-50)" },
  { token: "green", background: "var(--color-green-700)", foreground: "var(--color-gray-50)" },
  { token: "pink", background: "var(--color-pink-700)", foreground: "var(--color-gray-50)" },
  { token: "yellow", background: "var(--color-yellow-700)", foreground: "var(--color-gray-50)" },
  { token: "cyan", background: "var(--color-cyan-700)", foreground: "var(--color-gray-50)" },
  { token: "red", background: "var(--color-red-700)", foreground: "var(--color-gray-50)" },
] as const;

export type AccountColorToken = (typeof ACCOUNT_COLORS)[number]["token"];

export const isAccountColorToken = (value: unknown): value is AccountColorToken =>
  typeof value === "string" && ACCOUNT_COLORS.some((c) => c.token === value);

/** Estilo do selo para um token; `undefined` sem cor (ou com um nome que não é da paleta). */
export function accountBadgeStyle(token: string | null | undefined): CSSProperties | undefined {
  const color = ACCOUNT_COLORS.find((c) => c.token === token);
  return color ? { backgroundColor: color.background, color: color.foreground } : undefined;
}

/**
 * As iniciais do selo (porte de `providerInstanceInitials`, do T3 Code). Pontuação separa
 * palavras ("Codex (hub)" é CH, não "C("); apóstrofo dentro da palavra fica ("Theo's Codex" é
 * TC). Uma palavra só em camel case parte nas corcovas ("ClaudeProx" é CP), mas "ClaudeProx
 * Work" mantém as próprias palavras (CW).
 */
export function accountInitials(label: string): string {
  const toWords = (text: string) =>
    text
      .split(/\s+/u)
      .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
      .filter(Boolean);
  let words = toWords(label.replace(/[^\P{P}'’]+/gu, " "));
  if (words.length === 1) words = toWords(words[0]!.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

type Identificavel = Pick<AgentAccount, "id" | "agentId" | "name" | "displayName" | "accentColor">;

export const isSystemAccountId = (id: string) => id.startsWith("system:");

/**
 * O nome que a pessoa vê: o de exibição; sem ele, "Principal" para a conta do sistema e o nome
 * da pasta para as demais. `principalLabel` vem de `t("accounts.principalName")`.
 */
export function accountDisplayLabel(account: Identificavel, principalLabel: string): string {
  const custom = account.displayName?.trim();
  if (custom) return custom;
  return isSystemAccountId(account.id) ? principalLabel : account.name;
}

/**
 * O selo aparece se a conta tem cor própria ou se há mais de uma conta do mesmo agente
 * (mesma regra do T3 Code): com uma conta só e sem cor, o selo não diz nada.
 */
export function shouldShowAccountBadge(account: Identificavel, all: readonly Identificavel[]): boolean {
  if (isAccountColorToken(account.accentColor)) return true;
  let sameAgent = 0;
  for (const other of all) {
    if (other.agentId === account.agentId && ++sameAgent > 1) return true;
  }
  return false;
}
