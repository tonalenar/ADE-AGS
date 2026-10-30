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
  /** O painel direito e a aba dele; `null` = fechado; `"empty"` = aberto sem nada aberto ("Abrir uma superfície"). */
  panel: RightPanelTab | null;
  /** A aba que estava à vista quando o painel foi fechado: reabrir volta nela. `null` = nenhuma (reabre vazio). */
  lastPanel: Exclude<RightPanelTab, "empty"> | null;
  /** Muda a cada pedido de "foque o painel" (o atalho do Time); o painel leva o foco para dentro. */
  panelFocus: number;
  /** O painel ocupa a área toda (a conversa some), como o "Maximizar" do T3. */
  panelMaximized: boolean;
  /** O navegador da aba Navegador e onde desenhá-lo (como o terminal: por slot, sem remontar). */
  browser: { viewId: string; rect: Rect } | null;
  /** A conversa por protocolo aberta (ver `structured/`); `null` = a da aba ativa. */
  thread: string | null;
  /** As superfícies abertas no painel direito, além do Diff, na ordem em que foram abertas (prancheta 8). */
  surfaces: Surface[];
  /** O aparelho escolhido em cada aba de dispositivo (pranchetas 9 e 10) e o nome curto dele, que vira o da aba. */
  devices: { ios: string | null; android: string | null };
  deviceNames: { ios: string | null; android: string | null };
  /** A chave "Permitir que agentes controlem dispositivos": desligada, o agente só vê (shot/tree). */
  deviceControl: boolean;
  /** A largura do painel direito, arrastando a borda (lembrada entre sessões). */
  panelWidth: number;
  /** Um texto para o composer da conversa aberta (a captura de um aparelho); `seq` muda a cada pedido. */
  composerInsert: { seq: number; text: string } | null;
  /** O design pedido para a aba Design (`ags design open`); `seq` muda a cada pedido. */
  designOpen: DesignOpenRequest | null;
  /** As mensagens na fila de cada conversa (⌘⏎ com o agente trabalhando), na ordem. */
  queues: Record<string, string[]>;
}

/** Um pedido de abrir um design no painel: o design e, se vier, a prancheta e a página. */
export interface DesignOpenRequest { designId: string; artboardId?: string | null; pageId?: string | null; seq: number }

/** O que se abre no painel direito pelo "+" (o Diff está sempre lá; "empty" não é aba). */
export type Surface = Exclude<RightPanelTab, "diff" | "empty">;
export const SURFACES: Surface[] = ["team", "browser", "files", "design", "ios", "android"];

/** `team`: o painel Time do time de agentes (pranchetas 15 e 16, `team/TeamPanel.tsx`). `empty`: o estado vazio do T3. */
export type RightPanelTab = "diff" | "files" | "browser" | "design" | "ios" | "android" | "team" | "empty";

/** Um aparelho no painel: o simulador iOS ou o Android (pranchetas 9 e 10). */
export type DeviceKind = "ios" | "android";

const CONTROL_KEY = "ags.chat.deviceControl";
const WIDTH_KEY = "ags.chat.panelWidth";

/** A largura padrão do painel direito (a do T3 Code) e os limites do arrasto. */
export const PANEL_W = { initial: 540, min: 360, conversationMin: 520 } as const;

/** A largura do painel que cabe em `room` (painel + conversa): nunca menor que o mínimo nem tirando da conversa o mínimo dela. Pura. */
export function clampPanelWidth(width: number, room: number): number {
  const max = Math.max(PANEL_W.min, room - PANEL_W.conversationMin);
  return Math.round(Math.min(max, Math.max(PANEL_W.min, Number.isFinite(width) ? width : PANEL_W.initial)));
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n >= PANEL_W.min ? n : PANEL_W.initial;
  } catch {
    return PANEL_W.initial;
  }
}

function readControl(): boolean {
  try {
    return localStorage.getItem(CONTROL_KEY) !== "off";
  } catch {
    return true;
  }
}

export const useChatStore = create<ChatState>(() => ({
  slot: null, composing: false, terminalOpen: {}, panel: null, lastPanel: null, panelFocus: 0, panelMaximized: false, browser: null, thread: null, surfaces: [],
  devices: { ios: null, android: null }, deviceNames: { ios: null, android: null }, deviceControl: readControl(), composerInsert: null, designOpen: null, panelWidth: readWidth(),
  queues: {},
}));

/** Põe uma mensagem no fim da fila da conversa. */
export function enqueueMessage(key: string, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  useChatStore.setState((s) => ({ queues: { ...s.queues, [key]: [...(s.queues[key] ?? []), clean] } }));
}

/** Tira a primeira mensagem da fila (a que vai sair agora). */
export function dequeueMessage(key: string): string | null {
  const list = useChatStore.getState().queues[key] ?? [];
  if (list.length === 0) return null;
  const [first, ...rest] = list;
  useChatStore.setState((s) => {
    const queues = { ...s.queues };
    if (rest.length > 0) queues[key] = rest;
    else delete queues[key];
    return { queues };
  });
  return first!;
}

/** Esvazia a fila de uma conversa. */
export function clearQueue(key: string): void {
  useChatStore.setState((s) => {
    const queues = { ...s.queues };
    delete queues[key];
    return { queues };
  });
}

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
  useChatStore.setState((s) => {
    if (panel) return { panel };
    // Ao fechar, lembra a aba à vista (o vazio não conta); fechar de novo, já fechado, não apaga a lembrança.
    const last = s.panel && s.panel !== "empty" ? s.panel : s.lastPanel;
    return { panel: null, panelMaximized: false, lastPanel: last };
  });
}

/** Esquece a aba lembrada: a próxima abertura do painel (conversa nova) mostra o estado vazio. */
export function forgetLastPanel(): void {
  if (useChatStore.getState().lastPanel !== null) useChatStore.setState({ lastPanel: null });
}

/** Abre o painel Time e leva o foco para ele (o atalho do Time). */
export function openTeamPanelFocused(): void {
  addSurface("team");
  useChatStore.setState((s) => ({ panelFocus: s.panelFocus + 1 }));
}

/** Abre uma superfície no painel (e mostra). */
export function addSurface(surface: Surface): void {
  useChatStore.setState((s) => ({ surfaces: s.surfaces.includes(surface) ? s.surfaces : [...s.surfaces, surface], panel: surface }));
}

/** Fecha uma superfície; se era a que estava à vista, volta ao Diff. */
export function removeSurface(surface: Surface): void {
  useChatStore.setState((s) => ({ surfaces: s.surfaces.filter((x) => x !== surface), panel: s.panel === surface ? "diff" : s.panel }));
}

/** O nome de uma aba de navegador: o host com a porta (`localhost:1420`); `null` sem endereço. Pura. */
export function hostLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.host || null;
  } catch {
    return null;
  }
}

/** Abre ou fecha o painel: aberto sem nada antes, mostra o estado vazio; com uma aba já aberta, volta nela. */
export function toggleRightPanel(): void {
  const s = useChatStore.getState();
  setRightPanel(s.panel ? null : s.lastPanel ?? "empty");
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

/** Escolhe o aparelho de uma aba de dispositivo e guarda o nome curto (o da aba). */
export function setPanelDevice(kind: DeviceKind, id: string | null, name: string | null): void {
  const s = useChatStore.getState();
  if (s.devices[kind] === id && s.deviceNames[kind] === name) return;
  useChatStore.setState({ devices: { ...s.devices, [kind]: id }, deviceNames: { ...s.deviceNames, [kind]: name } });
}

/** Liga ou desliga o controle dos aparelhos do painel pelos agentes (lembrado entre sessões). */
export function setDeviceControl(on: boolean): void {
  try {
    localStorage.setItem(CONTROL_KEY, on ? "on" : "off");
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  useChatStore.setState({ deviceControl: on });
}

/** Põe um texto no composer da conversa aberta (a captura de um aparelho, como `@caminho`). */
export function insertIntoComposer(text: string): void {
  useChatStore.setState((s) => ({ composerInsert: { seq: (s.composerInsert?.seq ?? 0) + 1, text } }));
}

/** Muda a largura do painel direito; `save` grava (no fim do arrasto, não a cada pixel). */
export function setPanelWidth(width: number, save = false): void {
  if (useChatStore.getState().panelWidth !== width) useChatStore.setState({ panelWidth: width });
  if (!save) return;
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

/** Abre a aba Design do painel direito com este design (e a prancheta/página pedidas). */
export function openDesignInPanel(req: Omit<DesignOpenRequest, "seq">): void {
  useChatStore.setState((s) => ({
    designOpen: { ...req, seq: (s.designOpen?.seq ?? 0) + 1 },
    surfaces: s.surfaces.includes("design") ? s.surfaces : [...s.surfaces, "design"],
    panel: "design",
  }));
}
