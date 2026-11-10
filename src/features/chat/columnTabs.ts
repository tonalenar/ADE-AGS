import type { RightPanelTab } from "./store";

/**
 * As abas da coluna direita (a barra de abas do T3 Code): o modelo puro, sem React nem store.
 *
 * Uma aba é só um "assento" na barra. O que ela mostra vive fora dela: o navegador é uma `ViewTab` e o terminal é uma
 * aba de shell, ambos desenhados pelo `ViewTabsHost`/`TerminalPanel` e posicionados por cima do slot da aba ativa. Trocar
 * de aba, portanto, só troca QUEM publica o retângulo; nenhuma instância é desmontada (ver `store.ts`).
 */

/** O que uma aba da coluna pode ser: toda aba do painel direito, menos o estado vazio. */
export type ColumnKind = Exclude<RightPanelTab, "empty">;

export interface ColumnTab {
  id: string;
  kind: ColumnKind;
  /**
   * O recurso nativo que a aba mostra, por "escopo": o navegador (`ViewTab`) e o shell (aba de terminal) dependem da
   * conversa/pasta à vista, e a coluna é uma só para todas elas. Chave = escopo (ver `browserScope`/`shellScope`),
   * valor = id do recurso. Trocar de conversa e voltar devolve a mesma página/shell a cada aba.
   */
  resources?: Record<string, string>;
  /** O perfil do navegador pedido pelo submenu do Browser, aplicado quando a página nasce. */
  profileId?: string;
}

/** As superfícies que aceitam várias abas ao mesmo tempo; as outras têm uma só (abrir de novo foca a que existe). */
export const MULTI_KINDS: readonly ColumnKind[] = ["browser", "shell"];

export const isMultiKind = (kind: ColumnKind): boolean => MULTI_KINDS.includes(kind);

export interface ColumnState {
  tabs: ColumnTab[];
  /** A aba à vista; `null` = nenhuma (o estado vazio "Abrir uma superfície"). */
  active: string | null;
}

let seq = 0;
/** Um id de aba novo (único na sessão). */
export function newColumnTabId(kind: ColumnKind): string {
  seq += 1;
  return `ct-${kind}-${seq}`;
}

/**
 * Abre uma aba de `kind` e a deixa ativa. Superfície de uma aba só: foca a que já existe. Multi (navegador, terminal):
 * com `forceNew` cria sempre outra; sem, foca a ativa/primeira do tipo (é o que `setRightPanel("browser")` pede).
 */
export function openTab(state: ColumnState, kind: ColumnKind, opts: { forceNew?: boolean; profileId?: string } = {}): ColumnState & { id: string } {
  const sameKind = state.tabs.filter((tab) => tab.kind === kind);
  if (sameKind.length > 0 && !(opts.forceNew && isMultiKind(kind))) {
    const current = sameKind.find((tab) => tab.id === state.active) ?? sameKind[0]!;
    return { tabs: state.tabs, active: current.id, id: current.id };
  }
  const tab: ColumnTab = { id: newColumnTabId(kind), kind, ...(opts.profileId ? { profileId: opts.profileId } : {}) };
  return { tabs: [...state.tabs, tab], active: tab.id, id: tab.id };
}

/**
 * Fecha uma aba. Se era a ativa, a vizinha da direita assume (a da esquerda, se era a última); sem nenhuma restante,
 * `active` vira `null` (estado vazio). Fechar outra aba não muda a ativa.
 */
export function closeTab(state: ColumnState, id: string): ColumnState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.active !== id) return { tabs, active: state.active };
  return { tabs, active: (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null };
}

/** Move a aba `id` para a posição `to` (índice na lista já sem ela). Fora do intervalo, vai para a ponta. */
export function moveTab(tabs: ColumnTab[], id: string, to: number): ColumnTab[] {
  const from = tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return tabs;
  const rest = tabs.filter((tab) => tab.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  if (at === from) return tabs;
  return [...rest.slice(0, at), tabs[from]!, ...rest.slice(at)];
}

/**
 * Mantém a barra coerente com `panel` (a fonte que o resto do app lê e escreve: `setRightPanel`, atalhos, comandos).
 * Devolve o que corrigir no estado, ou `null` se já está certo:
 * - painel numa superfície sem aba ativa dela → ativa a primeira do tipo, ou cria uma;
 * - painel vazio → nenhuma ativa;
 * - painel fechado (`null`) → não mexe (reabrir volta na aba que estava).
 */
export function reconcileColumn(panel: RightPanelTab | null, state: ColumnState): ColumnState | null {
  if (panel === null) return null;
  if (panel === "empty") return state.active === null ? null : { tabs: state.tabs, active: null };
  const active = state.tabs.find((tab) => tab.id === state.active);
  if (active && active.kind === panel) return null;
  const existing = state.tabs.find((tab) => tab.kind === panel);
  if (existing) return { tabs: state.tabs, active: existing.id };
  const tab: ColumnTab = { id: newColumnTabId(panel), kind: panel };
  return { tabs: [...state.tabs, tab], active: tab.id };
}

/** O `panel` que corresponde à aba ativa: a superfície dela, ou `"empty"` sem aba. */
export function panelOfActive(state: ColumnState): ColumnKind | "empty" {
  return state.tabs.find((tab) => tab.id === state.active)?.kind ?? "empty";
}

/** A chave do escopo do navegador: quem o dono é (conversa) e a pasta. */
export function browserScope(cwd: string, owner: { kind: string; id: string } | null): string {
  return `${owner ? `${owner.kind}:${owner.id}` : "user"}|${cwd}`;
}

/** A chave do escopo do shell: a pasta da conversa. */
export function shellScope(cwd: string): string {
  return cwd;
}

/**
 * O recurso que uma aba mostra neste escopo. Prefere o que a aba já guardou (se ainda é válido); senão o primeiro
 * candidato que nenhuma OUTRA aba reservou. `null` = não há candidato livre (a superfície cria um novo). Pura.
 */
export function pickResource(
  tab: ColumnTab | undefined,
  scope: string,
  candidates: readonly string[],
  tabs: readonly ColumnTab[],
): string | null {
  const own = tab?.resources?.[scope];
  if (own && candidates.includes(own)) return own;
  const claimed = new Set(tabs.filter((other) => other.id !== tab?.id).map((other) => other.resources?.[scope]).filter(Boolean));
  return candidates.find((id) => !claimed.has(id)) ?? null;
}

/**
 * O nome da aba na barra, como chave de i18n + parâmetros. Navegador usa o host da página (o `title` vem do caller);
 * o terminal numera a partir da segunda aba ("Terminal 2"). Pura.
 */
export function tabLabelKey(tab: ColumnTab, tabs: readonly ColumnTab[]): { key: string; index: number } {
  const same = tabs.filter((other) => other.kind === tab.kind);
  return { key: `chat.panel.tab.${tab.kind}`, index: same.length > 1 ? same.findIndex((other) => other.id === tab.id) + 1 : 0 };
}
