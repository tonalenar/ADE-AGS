import { DESKTOP_OS } from "@/app/platform";

import type { Surface } from "./store";
import { SUMMARY_KEY } from "./summary/summaryModel";

/**
 * O menu "Abrir uma superfície" do painel direito (o estado vazio e o "+" do topo, como no T3 Code):
 * cada linha tem uma tecla de atalho, que vale com o foco no painel. Tudo puro, para testar sem tela.
 */
export type PanelChoice = Surface | "summary" | "diff" | "terminal" | "pr";

export interface PanelEntry {
  id: PanelChoice;
  /** A tecla (minúscula), sem modificador. */
  key: string;
}

/**
 * A ordem e as teclas. As do T3 ficam (B, T, F, D, P); o resto é do ADE: R de Resumo (a superfície padrão),
 * S de Design, I de iOS, A de Android e O de Orquestrador para o Time (o M do T3 é "Device", que aqui são o I e o A, e o T
 * já é do Terminal).
 */
export const PANEL_ENTRIES: PanelEntry[] = [
  { id: "summary", key: SUMMARY_KEY },
  { id: "browser", key: "b" },
  { id: "terminal", key: "t" },
  { id: "files", key: "f" },
  { id: "diff", key: "d" },
  { id: "design", key: "s" },
  { id: "ios", key: "i" },
  { id: "android", key: "a" },
  { id: "team", key: "o" },
  { id: "pr", key: "p" },
];

/**
 * A fileira de ícones da barra do painel (como o painel do Claude Code): Resumo, Terminal, Diff,
 * Navegador, Aparelho (o simulador iOS) e Arquivos. O resto (Design, Android, Time, PR) fica no `⋯`.
 */
export const ROW_CHOICES: PanelChoice[] = ["summary", "terminal", "diff", "browser", "ios", "files"];

/** As linhas que sobram para o menu `⋯`, na ordem de `PANEL_ENTRIES`. */
export const MORE_ENTRIES: PanelEntry[] = PANEL_ENTRIES.filter((e) => !ROW_CHOICES.includes(e.id));

/** O que está disponível agora: o terminal precisa de uma conversa com gaveta; o PR ainda não tem aba no painel. */
export interface PanelAvailability {
  terminal: boolean;
  pr: boolean;
}

export function isAvailable(id: PanelChoice, available: PanelAvailability): boolean {
  if (id === "terminal") return available.terminal;
  if (id === "pr") return available.pr;
  return true;
}

/** A linha que uma tecla aciona; `null` = tecla sem uso, com modificador, ou linha esmaecida. Pura. */
export function entryForKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, available: PanelAvailability): PanelEntry | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  const entry = PANEL_ENTRIES.find((x) => x.key === key);
  return entry && isAvailable(entry.id, available) ? entry : null;
}

/** A tecla como se mostra na caixinha da linha. */
export const keyLabel = (entry: PanelEntry): string => entry.key.toUpperCase();

// ── O atalho global do painel Time ───────────────────────────────────

/**
 * Abre o painel Time e foca nele. No macOS é ⌥⌘T; nos outros, Ctrl+Shift+O (Ctrl+Alt+T abre o terminal
 * do Linux e, no Windows, Ctrl+Alt é o AltGr). Conferido contra os atalhos do app: nenhum usa esses acordes.
 */
export const TEAM_SHORTCUT = DESKTOP_OS === "macos" ? "⌥⌘T" : "Ctrl+Shift+O";
/** Como a lista das Configurações desenha (cada tecla numa caixinha). */
export const TEAM_SHORTCUT_KEYS = DESKTOP_OS === "macos" ? "⌥+⌘+T" : "Ctrl+Shift+O";

export interface Chord { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

/** O evento é o acorde do Time? Com ⌥ a `key` vira outro caractere no Mac; por isso a tecla física (`code`). Pura. */
export function matchTeamShortcut(e: Chord, os: string = DESKTOP_OS): boolean {
  if (os === "macos") return e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === "KeyT" || e.key.toLowerCase() === "t");
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "o";
}
