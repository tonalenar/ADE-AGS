import { create } from "zustand";

import type { Rect } from "@/features/tabs/layout/layoutStore";
import type { ArchivedMessageSearchHit } from "@/features/sessions/ipc.conversations";

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
  /** A pasta que o "+" de um projeto da barra pede para a tela "Nova conversa" (a casca a lê uma vez e limpa). */
  composeFolder: string | null;
  /** A gaveta do terminal aberta, por conversa (aba). Ausente = o padrão da conversa. */
  terminalOpen: Record<string, boolean>;
  /** O painel direito e a aba dele; `null` = fechado; `"empty"` = aberto sem nada aberto ("Abrir uma superfície"). */
  panel: RightPanelTab | null;
  /**
   * O Resumo ligado (o ícone dele marcado; lembrado): sem outro painel aberto, ele é a coluna fixa à direita da conversa,
   * abaixo da barra de ícones, como no Claude Code. Abrir outro painel a substitui; fechar o painel a traz de volta.
   */
  summaryPinned: boolean;
  /** Com outro painel aberto: o Resumo como cartão flutuante encostado no painel (fecha com clique fora, Esc, ao
   * trocar de conversa ou ao fechar o painel). */
  summaryOpen: boolean;
  /** A aba que estava à vista quando o painel foi fechado: reabrir volta nela. `null` = nenhuma (reabre vazio). */
  lastPanel: Exclude<RightPanelTab, "empty"> | null;
  /** Muda a cada pedido de "foque o painel" (o atalho do Time); o painel leva o foco para dentro. */
  panelFocus: number;
  /** O painel ocupa a área toda (a conversa some), como o "Maximizar" do T3. */
  panelMaximized: boolean;
  /** O navegador da aba Navegador e onde desenhá-lo (como o terminal: por slot, sem remontar). */
  browser: { viewId: string; rect: Rect } | null;
  /** O navegador está destacado como mini preview sobre a conversa. */
  browserFloating: boolean;
  /** Posição e tamanho do mini preview, relativos à casca do chat. */
  browserFloatRect: Rect | null;
  /** Um aparelho (iOS ou Android) flutuando sobre a conversa, como o navegador: um preview por vez. `null` = nenhum. */
  deviceFloat: DeviceKind | null;
  /** O terminal da aba Terminal do painel (uma aba de shell na pasta da conversa) e onde desenhá-lo, como o navegador. */
  shell: { tabId: string; rect: Rect } | null;
  /** A conversa por protocolo aberta (ver `structured/`); `null` = a da aba ativa. */
  thread: string | null;
  /** Resultado escolhido na busca local: a timeline rola até o item após abrir a conversa. */
  threadSearchTarget: { threadId: string; itemId: string; token: number } | null;
  /** Resultado da busca no transcript de uma TUI aberta: a timeline rola até o item. */
  tabSearchTarget: { tabId: string; itemId: string; token: number } | null;
  /** Pedido local para abrir a busca na timeline desta conversa. */
  timelineFind: { conversationKey: string; token: number } | null;
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
  composerInsert: { seq: number; text: string; target?: string | null } | null;
  /** Pedidos de inserção que ainda não chegaram ao composer da conversa de destino. */
  composerInsertQueue: { seq: number; text: string; target?: string | null }[];
  /** Arquivos produzidos numa superfície (por exemplo, uma gravação de tela) para anexar ao composer. */
  composerAttach: { seq: number; paths: string[]; target?: string | null } | null;
  /** Pedidos de anexo pendentes; uma restauração em andamento não sobrescreve capturas anteriores. */
  composerAttachQueue: { seq: number; paths: string[]; target?: string | null }[];
  /** O design pedido para a aba Design (`ags design open`); `seq` muda a cada pedido. */
  designOpen: DesignOpenRequest | null;
  /** Fala arquivada aberta em prévia local, sem retomar o agente. */
  archivedMessagePreview: { workspaceId: string; hit: ArchivedMessageSearchHit } | null;
  /** As mensagens na fila de cada conversa (⌘⏎ com o agente trabalhando), na ordem. */
  queues: Record<string, QueuedMessage[]>;
}

/** Um pedido de abrir um design no painel: o design e, se vier, a prancheta e a página. */
export interface DesignOpenRequest { designId: string; artboardId?: string | null; pageId?: string | null; seq: number }

/** O que se abre no painel direito pelo "+" (o Resumo e o Diff estão sempre lá; "empty" não é aba). */
export type Surface = Exclude<RightPanelTab, "diff" | "shell" | "empty" | "tasks">;
export const SURFACES: Surface[] = ["team", "browser", "files", "design", "ios", "android", "pr", "side", "renders", "snapshots"];

/**
 * As abas do painel direito. O Resumo não é uma delas: sem painel ele é a coluna fixa da conversa (`summaryPinned`),
 * com painel é um cartão flutuante (`summaryOpen`, `summary/SummaryPopover.tsx`), como no Claude Code. `team`: o painel Time do time de agentes (pranchetas 15 e 16,
 * `team/TeamPanel.tsx`). `tasks`: as tarefas em segundo plano da conversa (`tasks/TasksPanel.tsx`; não volta sozinha ao
 * reabrir o app). `empty`: o estado vazio do T3.
 */
export type RightPanelTab = "diff" | "shell" | "files" | "browser" | "design" | "ios" | "android" | "team" | "tasks" | "pr" | "side" | "renders" | "snapshots" | "empty";

/** Um aparelho no painel: o simulador iOS ou o Android (pranchetas 9 e 10). */
export type DeviceKind = "ios" | "android";

const PANEL_KEY = "ags.chat.panel";
const PANELS: readonly string[] = ["diff", "files", "browser", "design", "ios", "android", "team", "pr", "side", "renders", "snapshots"];

/**
 * O painel lembrado: a superfície que estava à vista, ou `"none"` (a pessoa o fechou). Sem nada
 * guardado, ou com lixo, abre no Resumo (o padrão). Pura.
 */
/**
 * As superfícies abertas quando o app reabre: a aba salva volta à vista, e se ela é uma superfície (o iPhone, o
 * Android, o navegador…) tem de voltar aberta também. Sem isso o painel mostrava o iPhone, mas o compartilhamento
 * com os agentes (`sharedDevices`) saía vazio e `ags sim act` dizia "não está conectado com você". Pura.
 */
export function initialSurfaces(panel: RightPanelTab | null): Surface[] {
  return panel && (SURFACES as RightPanelTab[]).includes(panel) ? [panel as Surface] : [];
}

export function parsePanel(raw: string | null): RightPanelTab | null {
  if (raw === "none") return null;
  // O Time só abre quando a pessoa o pede naquela hora: nunca volta sozinho ao reabrir o app.
  // O Resumo era uma aba lembrada; agora é um cartão flutuante que nunca abre sozinho: o painel volta fechado.
  if (raw === "team" || raw === "summary") return null;
  return raw && PANELS.includes(raw) ? (raw as RightPanelTab) : null;
}

/**
 * O painel ao entrar numa conversa nova: o Time (que sobrou da conversa anterior) sai de cena, a menos que a
 * pessoa já tenha montado um time em rascunho; qualquer outra aba, ou o painel fechado, fica como ela deixou. Pura.
 */
export function panelForNewConversation(panel: RightPanelTab | null, draftEmpty: boolean): RightPanelTab | null {
  return panel === "team" && draftEmpty ? null : panel;
}

function readPanel(): RightPanelTab | null {
  try {
    return parsePanel(localStorage.getItem(PANEL_KEY));
  } catch {
    return null;
  }
}

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

const SUMMARY_KEY = "ags.chat.summaryPinned";

/** O Resumo ligado, lembrado entre aberturas; ligado por padrão (como no Claude Code). */
function readSummaryPinned(): boolean {
  try {
    return localStorage.getItem(SUMMARY_KEY) !== "off";
  } catch {
    return true;
  }
}

function readControl(): boolean {
  try {
    return localStorage.getItem(CONTROL_KEY) !== "off";
  } catch {
    return true;
  }
}

const initialPanel = readPanel();

export const useChatStore = create<ChatState>(() => ({
  slot: null, composing: false, composeFolder: null, terminalOpen: {}, panel: initialPanel, summaryPinned: readSummaryPinned(), summaryOpen: false, lastPanel: null, panelFocus: 0, panelMaximized: false, browser: null, browserFloating: false, browserFloatRect: null, deviceFloat: null, shell: null, thread: null, threadSearchTarget: null, tabSearchTarget: null, timelineFind: null,
  surfaces: initialSurfaces(initialPanel),
  devices: { ios: null, android: null }, deviceNames: { ios: null, android: null }, deviceControl: readControl(), composerInsert: null, composerInsertQueue: [], composerAttach: null, composerAttachQueue: [], designOpen: null, panelWidth: readWidth(),
  queues: {}, archivedMessagePreview: null,
}));

let threadSearchToken = 0;
let timelineFindToken = 0;

/** Abre a busca local da conversa visível e leva o foco ao campo. */
export function requestTimelineFind(conversationKey: string): number {
  timelineFindToken += 1;
  useChatStore.setState({ timelineFind: { conversationKey, token: timelineFindToken } });
  return timelineFindToken;
}

/** Fecha somente o pedido que esta instância da busca ainda possui. */
export function clearTimelineFind(token: number): void {
  if (useChatStore.getState().timelineFind?.token === token) useChatStore.setState({ timelineFind: null });
}

/** Abre uma conversa por resultado de mensagem e pede à timeline que mostre o item encontrado. */
export function requestThreadSearchJump(threadId: string, itemId: string): number {
  threadSearchToken += 1;
  useChatStore.setState({ threadSearchTarget: { threadId, itemId, token: threadSearchToken } });
  return threadSearchToken;
}

/** Limpa apenas o salto que já foi aplicado; um clique mais novo permanece válido. */
export function clearThreadSearchJump(token: number): void {
  if (useChatStore.getState().threadSearchTarget?.token === token) useChatStore.setState({ threadSearchTarget: null });
}

/** Abre uma TUI pelo resultado de uma mensagem e pede à timeline que mostre o item. */
export function requestTabSearchJump(tabId: string, itemId: string): number {
  threadSearchToken += 1;
  useChatStore.setState({ tabSearchTarget: { tabId, itemId, token: threadSearchToken } });
  return threadSearchToken;
}

/** Limpa apenas o salto que já foi aplicado; um clique mais novo permanece válido. */
export function clearTabSearchJump(token: number): void {
  if (useChatStore.getState().tabSearchTarget?.token === token) useChatStore.setState({ tabSearchTarget: null });
}

/** Abre uma fala arquivada em modo somente leitura, sem lançar nem retomar o agente. */
export function openArchivedMessagePreview(workspaceId: string, hit: ArchivedMessageSearchHit): void {
  useChatStore.setState({ archivedMessagePreview: { workspaceId, hit } });
}

/** Fecha a prévia da fala arquivada. */
export function closeArchivedMessagePreview(): void {
  useChatStore.setState({ archivedMessagePreview: null });
}

/**
 * Uma mensagem esperando a vez no composer. `now` = a pessoa pediu «enviar agora» num motor que não aceita entrada no
 * meio do turno: ela vai na frente, assim que o turno parar.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  now?: boolean;
}

let queueSeq = 0;

/** Põe uma mensagem na fila da conversa: no fim, ou na frente (`now`, o «enviar agora» que para o turno). */
export function enqueueMessage(key: string, text: string, now = false): void {
  const clean = text.trim();
  if (!clean) return;
  queueSeq += 1;
  const item: QueuedMessage = now ? { id: `q${queueSeq}`, text: clean, now } : { id: `q${queueSeq}`, text: clean };
  useChatStore.setState((s) => {
    const list = s.queues[key] ?? [];
    // As de «agora» saem antes das outras, na ordem em que vieram.
    const at = now ? list.filter((m) => m.now).length : list.length;
    return { queues: { ...s.queues, [key]: [...list.slice(0, at), item, ...list.slice(at)] } };
  });
}

/** Tira a primeira mensagem da fila (a que vai sair agora). */
export function dequeueMessage(key: string): string | null {
  const list = useChatStore.getState().queues[key] ?? [];
  if (list.length === 0) return null;
  const [first, ...rest] = list;
  setQueue(key, rest);
  return first!.text;
}

/** Tira da fila a mensagem `id` e devolve o texto dela (para editar no composer), ou `null` se já saiu. */
export function unqueueMessage(key: string, id: string): string | null {
  const list = useChatStore.getState().queues[key] ?? [];
  const found = list.find((m) => m.id === id);
  if (!found) return null;
  setQueue(key, list.filter((m) => m.id !== id));
  return found.text;
}

/** Atualiza o texto de uma mensagem sem mudar seu ID, posição ou prioridade na fila. */
export function updateQueuedMessage(key: string, id: string, text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  let updated = false;
  useChatStore.setState((s) => {
    const list = s.queues[key] ?? [];
    const index = list.findIndex((m) => m.id === id);
    if (index < 0) return s;
    updated = true;
    const next = [...list];
    next[index] = { ...next[index]!, text: clean };
    return { queues: { ...s.queues, [key]: next } };
  });
  return updated;
}

function setQueue(key: string, list: QueuedMessage[]): void {
  useChatStore.setState((s) => {
    const queues = { ...s.queues };
    if (list.length > 0) queues[key] = list;
    else delete queues[key];
    return { queues };
  });
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

/** Publica o espaço do terminal da aba Terminal do painel (como `setChatSlot`, só muda com o retângulo). */
export function setChatShell(shell: { tabId: string; rect: Rect } | null): void {
  const now = useChatStore.getState().shell;
  if (now === shell || (now && shell && now.tabId === shell.tabId && sameRect(now.rect, shell.rect))) return;
  useChatStore.setState({ shell });
}

/** Abre a tela "Nova conversa" já com essa pasta escolhida (o "+" do cabeçalho de um projeto). */
export function composeIn(cwd: string): void {
  useChatStore.setState({ composing: true, composeFolder: cwd });
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
    if (panel) return { panel, ...(panel === "browser" ? { browserFloating: false, browserFloatRect: null } : {}) };
    // Ao fechar, lembra a aba à vista (o vazio não conta); fechar de novo, já fechado, não apaga a lembrança.
    const last = s.panel && s.panel !== "empty" ? s.panel : s.lastPanel;
    // O cartão flutuante do Resumo só existe com painel; sem ele, volta a coluna (se o Resumo estiver ligado).
    return { panel: null, panelMaximized: false, lastPanel: last, summaryOpen: false };
  });
}

/** Alterna a superfície Diff sem alterar o estado das outras superfícies. */
export function toggleDiffPanel(): void {
  setRightPanel(useChatStore.getState().panel === "diff" ? null : "diff");
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
  // Abrir a aba de um aparelho na coluna dispensa o flutuante dele: o mesmo aparelho não pode ter duas telas.
  useChatStore.setState((s) => ({ surfaces: s.surfaces.includes(surface) ? s.surfaces : [...s.surfaces, surface], panel: surface,
    ...(surface === "browser" ? { browserFloating: false, browserFloatRect: null } : {}),
    deviceFloat: s.deviceFloat === surface ? null : s.deviceFloat }));
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

/** Abre ou fecha o painel: aberto sem nada antes, mostra o Resumo; com uma aba já aberta, volta nela. */
export function toggleRightPanel(): void {
  const s = useChatStore.getState();
  setRightPanel(s.panel ? null : s.lastPanel ?? "empty");
}

/** Abre ou fecha o Resumo flutuante (com outro painel aberto). */
export function toggleSummary(): void {
  useChatStore.setState((s) => ({ summaryOpen: !s.summaryOpen }));
}

/** Liga ou desliga o Resumo (a coluna fixa, sem painel aberto). Lembrado. */
export function toggleSummaryPinned(): void {
  const next = !useChatStore.getState().summaryPinned;
  useChatStore.setState({ summaryPinned: next, summaryOpen: false });
  try {
    localStorage.setItem(SUMMARY_KEY, next ? "on" : "off");
  } catch {
    /* sem lembrar, vale nesta sessão */
  }
}

/** Fecha o Resumo flutuante (clique fora, Esc, troca de conversa). */
export function closeSummary(): void {
  if (useChatStore.getState().summaryOpen) useChatStore.setState({ summaryOpen: false });
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

/** Destaca o mesmo navegador sobre a conversa ou o devolve ao painel lateral. */
export function toggleChatBrowserFloating(): void {
  const state = useChatStore.getState();
  if (!state.browser) return;
  if (state.browserFloating) {
    useChatStore.setState({ browserFloating: false, browserFloatRect: null, panel: "browser", panelMaximized: false });
    return;
  }
  useChatStore.setState({
    browserFloating: true,
    browserFloatRect: null,
    deviceFloat: null,
    panel: null,
    panelMaximized: false,
    lastPanel: "browser",
    summaryOpen: false,
  });
}

/**
 * Faz um aparelho (iOS ou Android) flutuar sobre a conversa. Um preview por vez, como no T3: o navegador flutuante
 * sai de cena (a página segue na aba dele) e a tela nativa dele é solta da conversa.
 */
export function openDeviceFloat(kind: DeviceKind): void {
  const s = useChatStore.getState();
  if (s.deviceFloat === kind) return;
  if (s.browserFloating) setChatBrowser(null);
  // O aparelho entra nas superfícies da conversa mesmo sem aba no painel: é isso que o deixa com os agentes (`sharedDevices`).
  useChatStore.setState({
    deviceFloat: kind,
    browserFloating: false,
    browserFloatRect: null,
    summaryOpen: false,
    surfaces: s.surfaces.includes(kind) ? s.surfaces : [...s.surfaces, kind],
  });
}

/** Fecha o aparelho flutuante. O aparelho segue ligado: fechar a janela não o desliga. */
export function closeDeviceFloat(): void {
  if (useChatStore.getState().deviceFloat !== null) useChatStore.setState({ deviceFloat: null });
}

/** Publica o retângulo do mini preview sem trocar o id/página do navegador. */
export function setChatBrowserFloatRect(rect: Rect): void {
  const state = useChatStore.getState();
  if (!state.browser) return;
  const browserChanged = !sameRect(state.browser.rect, rect);
  const floatChanged = !sameRect(state.browserFloatRect, rect);
  if (!browserChanged && !floatChanged) return;
  useChatStore.setState({ browser: browserChanged ? { viewId: state.browser.viewId, rect } : state.browser, browserFloatRect: rect });
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
  // Desligar é revogar: o "sempre" que a pessoa deu ao JEV deixa de valer.
  if (!on) void import("./devicesIpc").then((m) => m.computerUseForget()).catch(() => undefined);
}

/** Põe um texto no composer da conversa de destino (a captura de um aparelho, como `@caminho`). */
export function insertIntoComposer(text: string, target?: string | null): void {
  useChatStore.setState((s) => {
    const seq = Math.max(s.composerInsert?.seq ?? 0, ...s.composerInsertQueue.map((item) => item.seq)) + 1;
    const request = { seq, text, target };
    return { composerInsert: request, composerInsertQueue: [...s.composerInsertQueue, request] };
  });
}

/** Pede ao composer aberto para anexar arquivos locais, sem enviá-los. */
export function attachToComposer(paths: string[], target?: string | null): void {
  const unique = [...new Set(paths.filter((path) => path.length > 0))];
  if (unique.length === 0) return;
  useChatStore.setState((s) => {
    const seq = Math.max(s.composerAttach?.seq ?? 0, ...s.composerAttachQueue.map((item) => item.seq)) + 1;
    const request = { seq, paths: unique, target };
    return { composerAttach: request, composerAttachQueue: [...s.composerAttachQueue, request] };
  });
}

/** Retira apenas os textos destinados ao composer ativo; os demais aguardam sua conversa. */
export function takeComposerInserts(target: string | null): { seq: number; text: string; target?: string | null }[] {
  let taken: { seq: number; text: string; target?: string | null }[] = [];
  useChatStore.setState((state) => {
    taken = state.composerInsertQueue.filter((item) => item.target == null || item.target === target);
    if (taken.length === 0) return state;
    const ids = new Set(taken.map((item) => item.seq));
    return { composerInsertQueue: state.composerInsertQueue.filter((item) => !ids.has(item.seq)) };
  });
  return taken;
}

/** Reconhece anexos só depois de a inspeção terminar no composer que os recebeu. */
export function acknowledgeComposerAttachments(sequences: number[]): void {
  if (sequences.length === 0) return;
  const ids = new Set(sequences);
  useChatStore.setState((state) => ({ composerAttachQueue: state.composerAttachQueue.filter((item) => !ids.has(item.seq)) }));
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

// A escolha do painel (inclusive fechá-lo) persiste entre as aberturas.
useChatStore.subscribe((state, prev) => {
  if (state.panel === prev.panel || state.panel === "empty") return;
  try {
    localStorage.setItem(PANEL_KEY, state.panel ?? "none");
  } catch {
    /* sem lembrar, vale só nesta abertura */
  }
});
