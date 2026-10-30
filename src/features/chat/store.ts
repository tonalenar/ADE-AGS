import { create } from "zustand";

import type { Rect } from "@/features/tabs/layout/layoutStore";

/**
 * O estado da casca do chat que não é de domínio: onde fica o terminal da conversa aberta e se
 * a tela é a de uma conversa nova.
 *
 * ## Por que um retângulo e não um terminal aqui dentro
 *
 * Desmontar `<Terminal>` mata o PTY. As conversas do chat são abas de agente de verdade, e o
 * terminal delas continua sendo desenhado pelo `TerminalPanel`, no mesmo lugar de sempre. A tela
 * da conversa só mede o espaço que reserva para ele e publica aqui; o `TerminalPanel` o posiciona
 * por cima (igual ao canvas com `liveRects`). Trocar de modo, então, não remonta nada.
 */
interface ChatState {
  /** Onde desenhar o terminal da conversa aberta, relativo à área de abas. `null` = nenhum. */
  slot: Rect | null;
  /** A tela de conversa nova está aberta (a hero com o composer), em vez da conversa ativa. */
  composing: boolean;
  /** A gaveta do terminal aberta, por conversa (aba). Ausente = o padrão da conversa. */
  terminalOpen: Record<string, boolean>;
  /** O painel direito e a aba dele; `null` = fechado. */
  panel: RightPanelTab | null;
  /** O painel ocupa a área toda (a conversa some), como o "Maximizar" do T3. */
  panelMaximized: boolean;
  /** O navegador da aba Navegador e onde desenhá-lo (como o terminal: por slot, sem remontar). */
  browser: { viewId: string; rect: Rect } | null;
}

export type RightPanelTab = "diff" | "files" | "browser" | "design" | "devices";

export const useChatStore = create<ChatState>(() => ({ slot: null, composing: false, terminalOpen: {}, panel: null, panelMaximized: false, browser: null }));

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/** Publica o espaço do terminal. Só muda o store se o retângulo mudou: o `TerminalPanel` repinta a cada mudança. */
export function setChatSlot(slot: Rect | null): void {
  if (sameRect(useChatStore.getState().slot, slot)) return;
  useChatStore.setState({ slot });
}

export function setComposing(composing: boolean): void {
  if (useChatStore.getState().composing !== composing) useChatStore.setState({ composing });
}

/** Abre ou fecha a gaveta do terminal de uma conversa. */
export function setTerminalOpen(tabId: string, open: boolean): void {
  useChatStore.setState((s) => ({ terminalOpen: { ...s.terminalOpen, [tabId]: open } }));
}

/** Abre o painel direito nesta aba; `null` fecha. */
export function setRightPanel(panel: RightPanelTab | null): void {
  useChatStore.setState(panel ? { panel } : { panel: null, panelMaximized: false });
}

export function toggleRightPanel(): void {
  setRightPanel(useChatStore.getState().panel ? null : "diff");
}

export function togglePanelMaximized(): void {
  useChatStore.setState((s) => ({ panelMaximized: !s.panelMaximized }));
}

/** Publica (ou tira) o navegador da aba Navegador. Só muda o store se algo mudou. */
export function setChatBrowser(browser: { viewId: string; rect: Rect } | null): void {
  const prev = useChatStore.getState().browser;
  if (prev === browser || (prev && browser && prev.viewId === browser.viewId && sameRect(prev.rect, browser.rect))) return;
  useChatStore.setState({ browser });
}
