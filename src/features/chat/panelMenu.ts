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
 * A ordem e as teclas do menu, as do T3 Code: B Browser, T Terminal, F Files, D Diff, P Pull request, M Device,
 * S Side chat. O que só o ADE tem fica com uma letra própria: E de Design, O de Orquestrador para o Time, R de Resumo
 * (o Resumo não é aba da coluna: é o botão do cabeçalho; a tecla vale no tooltip dele). O Android entra pelo submenu do
 * Device (M abre o iOS, que é o aparelho padrão); a tecla `a` dele só existe dentro do submenu.
 */
export const PANEL_ENTRIES: PanelEntry[] = [
  { id: "summary", key: SUMMARY_KEY },
  { id: "browser", key: "b" },
  { id: "terminal", key: "t" },
  { id: "files", key: "f" },
  { id: "diff", key: "d" },
  { id: "pr", key: "p" },
  { id: "ios", key: "m" },
  { id: "android", key: "a" },
  { id: "side", key: "s" },
  { id: "design", key: "e" },
  { id: "team", key: "o" },
];

/** As linhas do menu "Abrir uma superfície" (o "+" da barra e o estado vazio): sem o Resumo e sem o Android (submenu). */
export const MENU_ENTRIES: PanelEntry[] = PANEL_ENTRIES.filter((e) => e.id !== "summary" && e.id !== "android");

/** As linhas que têm submenu: o Browser lista os perfis (se houver mais de um) e o Device lista iOS e Android. */
export const SUBMENU_OWNERS: PanelChoice[] = ["browser", "ios"];

/** O terminal precisa de uma conversa com gaveta; PR depende da pasta do repositório. */
export interface PanelAvailability {
  terminal: boolean;
  pr: boolean;
  side?: boolean;
}

export function isAvailable(id: PanelChoice, available: PanelAvailability): boolean {
  if (id === "terminal") return available.terminal;
  if (id === "pr") return available.pr;
  if (id === "side") return !!available.side;
  return true;
}

/** A linha que uma tecla aciona; `null` = tecla sem uso, com modificador, ou linha esmaecida. Pura. */
export function entryForKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, available: PanelAvailability): PanelEntry | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  const entry = MENU_ENTRIES.find((x) => x.key === key);
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
