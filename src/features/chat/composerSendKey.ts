/**
 * O que a tecla Enter do composer faz, conforme "Enviar com" (Configurações → Chat). Pura: o teclado
 * entra como dados, sem evento de DOM, então a matriz inteira se testa sem tela.
 *
 * - `enter`: Enter envia; Shift+Enter quebra a linha; Cmd/Ctrl+Enter faz a ação oposta da padrão.
 * - `mod-enter-multiline`: Enter envia, mas numa mensagem com mais de uma linha quebra a linha; Cmd/Ctrl+Enter envia.
 * - `mod-enter`: só Cmd/Ctrl+Enter envia; Enter quebra a linha.
 *
 * Com Shift somado ao modificador nos modos que pedem Cmd/Ctrl, sai a ação oposta (como no T3 Code).
 */

export type SendShortcut = "enter" | "mod-enter-multiline" | "mod-enter";

export const SEND_SHORTCUTS: readonly SendShortcut[] = ["enter", "mod-enter-multiline", "mod-enter"];

export function isSendShortcut(value: unknown): value is SendShortcut {
  return value === "enter" || value === "mod-enter-multiline" || value === "mod-enter";
}

/**
 * `default`: envia pela ação padrão (fila ou steer, a escolha da pessoa); `opposite`: envia pela oposta;
 * `newline`: deixa o textarea quebrar a linha; `ignore`: não envia e não quebra a linha.
 */
export type EnterAction = "default" | "opposite" | "newline" | "ignore";

export interface EnterKeyInput {
  shortcut: SendShortcut;
  /** Cmd no macOS, Ctrl no resto. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** O texto já tem mais de uma linha. */
  multiline: boolean;
}

export function enterKeyAction({ shortcut, mod, shift, alt, multiline }: EnterKeyInput): EnterAction {
  if (mod && alt) return "ignore";
  if (mod && shift) return shortcut === "enter" ? "newline" : "opposite";
  if (shift) return "newline";
  if (mod) return shortcut === "enter" ? "opposite" : "default";
  // Enter sem modificador: o Alt sozinho não muda nada.
  if (shortcut === "enter") return "default";
  if (shortcut === "mod-enter-multiline") return multiline ? "newline" : "default";
  return "newline";
}

/** O nome da tecla de modificador na tela: Cmd no macOS (e iOS), Ctrl no resto. Pura. */
export function modifierLabel(userAgent: string): "Cmd" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/.test(userAgent) ? "Cmd" : "Ctrl";
}
