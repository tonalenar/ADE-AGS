/**
 * Lo que un agente le pide al navegador de las tabs, por el MCP (`ags mcp`) y el puente
 * de la CLI (`browser.run` en `cliBridge.ts`).
 *
 * Cada tab de navegador montada se registra acá con un `BrowserHost`: lo mínimo para que
 * un agente la maneje. Un pedido llega con la carpeta del proyecto y se atiende con el
 * navegador de esa carpeta — el que se está mirando, o el último que usó un agente —, y
 * si no hay ninguno y lo que pide es abrir una URL, se abre uno.
 *
 * Todo lo que devuelve es TEXTO para un modelo: corto, una cosa por línea, y con lo que
 * pasó en la consola y la red durante la acción, que es lo que un agente probando una
 * página necesita ver sin tener que preguntarlo aparte.
 */
import { AGENT_PORTAL_SIZE, neighbors } from "@/features/canvas/board";
import { boardKeyOfTab, canvasActions, flushSave, useCanvasStore, windowModeKey, workModeFor } from "@/features/canvas/store";
import { invoke } from "@tauri-apps/api/core";

import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type BrowserView, type ViewOwner } from "@/features/tabs/viewTabs";
import { setColumnTabResource, setRightPanel, toggleChatBrowserFloating, useChatStore } from "@/features/chat/store";
import { browserScope } from "@/features/chat/columnTabs";
import { subscribeToMeasuredChatBrowser } from "@/features/chat/browserMeasurement";
import { chatShellOn, useUiStore } from "@/app/uiStore";
import { useStructured } from "@/features/chat/structured/store";

import {
  consoleForAgent, isFailed, mergeCookies, networkForAgent, requestRows, type CookieRow,
} from "./debugLog";
import { debugLogOf, refreshProxyLog } from "./debugStore";
import {
  previewAddMock, previewClearMocks, previewCookies, previewListMocks, previewReadUpload, previewRequest, previewWafChallenge, type Mock,
} from "./ipc";
import {
  detectCaptcha, isCaptchaSelector, parsePointTarget, pointHitsCaptchaIframe,
  type CaptchaIframeRect, type DocumentSnapshot,
} from "./captcha";
import {
  getCaptchaHandoffForView, openCaptchaHandoff, resetCaptchaStore, resolveCaptchaHandoff, waitForCaptchaHandoff,
  type CaptchaHandoff,
} from "./captchaStore";
import { detailForAgent, detailFromPage, detailFromProxy } from "./networkDetail";
import { egressOriginFor, isLocalOrigin, redactForAgent, untrustedData } from "./egressPolicy";
import { askPersonAboutReset, tellPersonAboutResetFailure } from "./dialogPolicy";
import type { AnnotatedCapture } from "./composeMessage";
import {
  batchHeader, formatElement, formatMarked, type DescribedElement, type MarkedEntry,
} from "./markedView";
import { batchById, batchesFor, consumeMarks, newMarkId, pendingCount, type SentBatch } from "./markStore";
import type { LoadState, PageChannel } from "./pageChannel";
import { portalStateOf, type PortalStateInfo } from "./portalState";
import { browserToolPrefix } from "./tabMcp";
import type { PageCommand, PickedElement, StorageArea } from "./protocol";
import { clampViewport, presetById, VIEWPORT_PRESETS, type Viewport } from "./viewport";
import { checkExpectation, parseExpectations, verifyReport } from "./expect";
import { summarizeSnapshot } from "./finalSummary";
import { cartCount, fingerprint, formatResult, parseSnapshot, runPilot, type ParsedPage, type PilotDeps, type PilotResult } from "./jevPilot";
import { bareUrl, createLedger, forgetLedger, ledgerOf, type ActLedger, type PriorAction } from "./portalLedger";
import { backendSink, withProgress } from "./actProgress";
import { beginWindowMeasure } from "./windowBeat";
import { readBrowserPreferences } from "./browserPreferences";

export interface BrowserHost {
  viewId: string;
  cwd: string;
  channel: PageChannel;
  /** Carga una URL. Resuelve cuando se pidió, no cuando terminó de cargar. */
  navigate: (url: string) => Promise<void>;
  history: (action: "back" | "forward" | "reload") => void;
  /** `null` = ocupar todo el espacio (sin emular un tamaño). */
  setViewport: (viewport: Viewport | null) => void;
  /** Emular una pantalla táctil: media queries de hover/puntero y eventos de dedo. */
  setTouch: (on: boolean) => Promise<unknown>;
  touch: () => boolean;
  viewport: () => Viewport | null;
  proxyOrigin: () => string | null;
  /** El origen del servidor de verdad (`http://localhost:5173`). */
  targetOrigin: () => string | null;
  /** La URL que muestra la barra (la del servidor, no la del proxy). */
  currentUrl: () => string;
  /** Cuántas veces cargó un documento con el runtime. Sirve de marca para `waitForLoad`. */
  loadCount: () => number;
  /** O que se sabe da carga agora (para `ags portals` e para explicar uma falta de resposta). */
  loadState: () => LoadState;
  /** Espera a que cargue un documento posterior a `after`. `false` si venció el tope. */
  waitForLoad: (after: number, timeoutMs: number) => Promise<boolean>;
  /** Lo que la persona dejó señalado y todavía no mandó a nadie. */
  /** Lo que la persona tiene señalado en el panel de ESTA tab, sin mandar todavía. Lo que
   *  ya mandó vive en `markStore`, buscable por su id. */
  marks: () => Marks | null;
  /** Prende el selector y espera a que la persona marque algo. `null` = canceló o venció. */
  requestPick: (timeoutMs: number) => Promise<PickedElement | null>;
  /** Una foto de la página como se ve ahora, guardada en disco. Devuelve la ruta. `tag`
   *  dice de quién es: va en el nombre del archivo. */
  screenshot: (tag?: string) => Promise<string>;
  /** Uma foto da janela da página para a reserva visual do piloto. `complete` = a página inteira estava à vista (senão a foto sai cortada e as frações não valem). */
  visualShot: (region?: { left: number; top: number; right: number; bottom: number }, marks?: { left: number; top: number; right: number; bottom: number }[]) => Promise<{ path: string; complete: boolean; detail?: string }>;
  /** El panel de debug está abierto: solo mientras lo esté se anota la red. */
  debugOpen: () => boolean;
  /** Abre el panel de debug en la red, que es lo que prende el registro. A la vista de la
   *  persona a propósito: así sabe por qué está abierto. */
  openNetworkDebug: () => void;
  /** Liga ou desliga o observador de mutações de captcha dentro da página. */
  watchCaptcha?: (on: boolean) => void;
}

/** Elementos, capturas y nota: lo que la persona señaló de una vez. */
export interface Marks {
  picks: PickedElement[];
  captures: AnnotatedCapture[];
  note: string;
}

export type BrowserRequest = { op: string } & Record<string, unknown>;

const hosts = new Map<string, BrowserHost>();
/** El último navegador que usó un agente, por carpeta: si hay dos abiertos, sigue en el mismo. */
const lastUsed = new Map<string, string>();
/** En qué página lo dejó. Si el usuario cierra la tab del agente, es con lo que vuelve a
 *  abrirla donde estaba en vez de contestarle "no tenés ningún navegador". */
const lastUrl = new Map<string, string>();
const hostWaiters = new Set<() => void>();
/** Últimos iframes observados em cada vista, usados para recusar cliques por coordenada no iframe do desafio. */
const lastCaptchaIframes = new Map<string, CaptchaIframeRect[]>();
/** Último dono/portal conhecido por vista, para preencher nome do agente e foco no cartão de captcha. */
const lastCaptchaMeta = new Map<string, { owner: ViewOwner | null; portalId?: string }>();

/** Ops interativos bloqueados enquanto a aba tem um captcha aguardando a pessoa. Leitura continua liberada. */
const CAPTCHA_BLOCKED_OPS = new Set([
  "click", "type", "press", "drag", "select", "fillLogin", "eval", "act", "hover", "upload",
]);

/** Respostas geradas pela própria ADE (sem texto da página): não recebem envelope `UNTRUSTED DATA`. */
const CAPTCHA_APP_RESPONSE_RE = /^\{"(?:blocked":"captcha","handoff":"[^"]+"|resolved":true|expired":true|cancelled":true)\}$/;

const CAPTCHA_IFRAME_CLICK_REFUSED =
  "Clique recusado: o alvo cai dentro do iframe de captcha. Nunca tente resolver captcha; chame browser_wait_human.";

function captchaBlockedJson(handoffId: string): string {
  return JSON.stringify({ blocked: "captcha", handoff: handoffId });
}

export function captchaHandoffOf(viewId: string): CaptchaHandoff | null {
  return getCaptchaHandoffForView(viewId);
}

export function clearCaptchaState(): void {
  lastCaptchaIframes.clear();
  lastCaptchaMeta.clear();
  resetCaptchaStore();
}

function originOfHost(host: BrowserHost): string | null {
  const target = typeof host.targetOrigin === "function" ? host.targetOrigin() : null;
  if (target) return target;
  const rawUrl = typeof host.currentUrl === "function" ? host.currentUrl() : "";
  try {
    return rawUrl ? new URL(rawUrl).origin : null;
  } catch {
    return null;
  }
}

async function readProxyWafAction(host: BrowserHost): Promise<string | null> {
  const origin = originOfHost(host);
  if (!origin) return null;
  try {
    return await previewWafChallenge(origin);
  } catch {
    return null;
  }
}

async function readPageCaptchaSnapshot(host: BrowserHost): Promise<DocumentSnapshot | null> {
  try {
    const raw = await host.channel.run({ op: "captcha" }, 4_000);
    if (!raw || typeof raw !== "object") return null;
    const snap = raw as DocumentSnapshot;
    if (Array.isArray(snap.iframes)) lastCaptchaIframes.set(host.viewId, snap.iframes);
    return snap;
  } catch {
    return null;
  }
}

function agentNameOf(owner: ViewOwner | null): string {
  return owner?.label?.trim() || "Agente";
}

function applyCaptchaDetection(
  host: BrowserHost,
  snapshot: DocumentSnapshot,
  owner: ViewOwner | null,
  portalId?: string,
): CaptchaHandoff | null {
  if (Array.isArray(snapshot.iframes)) lastCaptchaIframes.set(host.viewId, snapshot.iframes);
  const kind = detectCaptcha(snapshot);
  if (!kind) {
    if (resolveCaptchaHandoff(host.viewId)) {
      host.watchCaptcha?.(false);
    }
    return null;
  }
  const url = snapshot.url || (typeof host.currentUrl === "function" ? host.currentUrl() : "") || originOfHost(host) || "";
  const { handoff } = openCaptchaHandoff({
    viewId: host.viewId,
    kind,
    url,
    agentName: agentNameOf(owner),
    cwd: host.cwd,
    owner,
    portalId,
  });
  host.watchCaptcha?.(true);
  return handoff;
}

/** Inspeciona o documento atual + WAF do proxy e atualiza o estado de captcha da vista. */
async function inspectCaptcha(
  host: BrowserHost,
  owner: ViewOwner | null,
  portalId?: string,
): Promise<CaptchaHandoff | null> {
  lastCaptchaMeta.set(host.viewId, { owner, portalId });
  const [pageSnap, wafAction] = await Promise.all([
    readPageCaptchaSnapshot(host),
    readProxyWafAction(host),
  ]);
  if (!pageSnap && !wafAction) {
    // Sem retrato (ex.: página ainda carregando ou mock simples): só limpa se já não há desafio conhecido.
    return getCaptchaHandoffForView(host.viewId);
  }
  const merged: DocumentSnapshot = {
    ...(pageSnap ?? {}),
    wafChallengeAction: pageSnap?.wafChallengeAction ?? wafAction,
  };
  return applyCaptchaDetection(host, merged, owner, portalId);
}

/** Chamado pelo `BrowserTab` quando o DOM muta sob observação (`captcha:state`). */
export async function onCaptchaDocumentEvent(viewId: string, snapshot: DocumentSnapshot): Promise<CaptchaHandoff | null> {
  const host = hosts.get(viewId);
  if (!host) return null;
  const wafAction = await readProxyWafAction(host);
  const meta = lastCaptchaMeta.get(viewId);
  return applyCaptchaDetection(
    host,
    { ...snapshot, wafChallengeAction: snapshot.wafChallengeAction ?? wafAction },
    meta?.owner ?? null,
    meta?.portalId,
  );
}

/** Chamado pelo `BrowserTab` após navegação/carga de documento (`nav`). */
export async function recheckCaptchaForView(viewId: string): Promise<CaptchaHandoff | null> {
  const host = hosts.get(viewId);
  if (!host) return null;
  const meta = lastCaptchaMeta.get(viewId);
  return inspectCaptcha(host, meta?.owner ?? null, meta?.portalId);
}

/**
 * Recusa sempre um clique cujo seletor ou coordenadas caiam dentro do iframe do desafio,
 * mesmo antes de a aba ter sido marcada com `captchaHandoff`.
 */
async function assertNotCaptchaIframeClick(host: BrowserHost, request: BrowserRequest): Promise<void> {
  const target = str(request, "target") ?? "";
  if (target && isCaptchaSelector(target)) {
    throw new Error(CAPTCHA_IFRAME_CLICK_REFUSED);
  }
  const point = target ? parsePointTarget(target) : null;
  const x = point?.x ?? num(request, "x");
  const y = point?.y ?? num(request, "y");
  if (x === undefined || y === undefined) return;
  let iframes = lastCaptchaIframes.get(host.viewId);
  if (!iframes) {
    const snap = await readPageCaptchaSnapshot(host);
    iframes = snap?.iframes ?? [];
  }
  if (pointHitsCaptchaIframe(x, y, iframes)) {
    throw new Error(CAPTCHA_IFRAME_CLICK_REFUSED);
  }
}

/** ¿Esa tab tiene algo señalado (pendiente o recién mandado)? */
function hasMarks(host: BrowserHost | undefined): boolean {
  return host?.marks() != null;
}

export function registerBrowserHost(host: BrowserHost): () => void {
  hosts.set(host.viewId, host);
  for (const wake of hostWaiters) wake();
  return () => {
    if (hosts.get(host.viewId) === host) {
      hosts.delete(host.viewId);
      lastCaptchaIframes.delete(host.viewId);
      lastCaptchaMeta.delete(host.viewId);
    }
  };
}

function waitForHost(viewId: string, timeoutMs: number): Promise<BrowserHost> {
  const ready = hosts.get(viewId);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const wake = () => {
      const host = hosts.get(viewId);
      if (!host) return;
      cleanup();
      resolve(host);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The browser tab did not finish mounting."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      hostWaiters.delete(wake);
    };
    hostWaiters.add(wake);
  });
}

const sameFolder = (a: string, b: string) =>
  comparablePath(a).replace(/\/+$/, "") === comparablePath(b).replace(/\/+$/, "");

/** O portal está ligado por corda a esse agente (em qualquer canvas). */
function linkedToAgent(agentId: string, portalId: string): boolean {
  return Object.values(useCanvasStore.getState().boards).some((b) => neighbors(b, portalId).includes(agentId));
}

/**
 * Abre um navegador no canvas do agente, ao lado dele e ligado por corda, se o canvas dele está à vista.
 * Devolve o id do portal, ou `null` (o agente não está num canvas à vista: vale a aba de sempre).
 */
async function openPortalFor(owner: ViewOwner, url: string): Promise<string | null> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === owner.id);
  if (!tab) return null;
  const key = boardKeyOfTab(tab);
  const board = useCanvasStore.getState().boards[key];
  if (!board || !(owner.id in board.nodes) || workModeFor(useCanvasStore.getState().modes, windowModeKey(), key) !== "canvas") return null;
  const created = canvasActions.addPortal(key, { name: undefined, url, near: owner.id, size: { ...AGENT_PORTAL_SIZE } });
  await flushSave(key);
  return created.id;
}

/** Uma espera por vista: a miniatura abre na primeira medida real do slot que mostra a página do agente. */
const pendingMiniatureMeasures = new Map<string, () => void>();

/**
 * Mostra sobre o chat a página que o agente acabou de abrir, quando a conversa é a atual. O slot do navegador só monta
 * com o painel no navegador, então o painel abre primeiro, a aba de navegador da coluna passa a mostrar a página do
 * agente, e a miniatura abre na primeira medida real desse slot. Não há retângulo inventado: a origem é essa medida.
 */
export function autoShowAgentBrowser(viewId: string, owner: ViewOwner | null): void {
  if (!owner || !readBrowserPreferences().autoShowFloatingPreview || !chatShellOn(useUiStore.getState())) return;
  const chat = useChatStore.getState();
  const activeTabId = useTabsStore.getState().activeTabId;
  const belongsToCurrentChat = owner.kind === "thread"
    ? owner.id === `thread:${chat.thread}`
    : owner.kind === "tab" && owner.id === activeTabId;
  const view = useViewTabsStore.getState().views.find((candidate) => candidate.id === viewId);
  if (!belongsToCurrentChat || !view || view.kind !== "browser") return;
  if (chat.browserFloating && chat.browser?.viewId === viewId) return;
  // Se o painel do navegador já está aberto e visível, apenas garante a página na coluna sem forçar salto para PiP.
  if (chat.panel === "browser" && !chat.browserFloating) {
    adoptBrowserInColumn(view.cwd, owner, viewId);
    return;
  }
  pendingMiniatureMeasures.get(viewId)?.();
  // Painel no navegador: é a única forma de o slot montar e medir. Com o painel fechado a miniatura nunca abria.
  if (chat.panel !== "browser") setRightPanel("browser");
  adoptBrowserInColumn(view.cwd, owner, viewId);
  const stop = subscribeToMeasuredChatBrowser(viewId, (measured) => {
    pendingMiniatureMeasures.delete(viewId);
    const current = useChatStore.getState();
    if (current.browserFloating || current.browser?.viewId !== measured.viewId) return;
    toggleChatBrowserFloating();
  });
  pendingMiniatureMeasures.set(viewId, stop);
}

/** A aba de navegador da coluna passa a mostrar a página do agente nesse escopo: o slot mede o que a aba mostra. */
function adoptBrowserInColumn(cwd: string, owner: ViewOwner, viewId: string): void {
  const state = useChatStore.getState();
  const tab = state.columnTabs.find((candidate) => candidate.id === state.columnActive && candidate.kind === "browser");
  if (tab) setColumnTabResource(tab.id, browserScope(cwd, owner), viewId);
}

/**
 * El navegador de este agente, abriéndole uno propio si todavía no tiene.
 *
 * Cada agente trabaja en SU tab y no en la que el usuario está mirando: dos agentes sobre
 * el mismo proyecto se pisarían la página, y el usuario perdería lo que tenía abierto cada
 * vez que uno navegara. La tab del agente se pinta de su color (ver `agentPaint`), igual
 * que la suya, para que se vea de quién es sin abrirla.
 */
async function hostFor(
  cwd: string,
  request: BrowserRequest,
  owner: ViewOwner | null
): Promise<{ host: BrowserHost; opened: boolean }> {
  const store = useViewTabsStore.getState();
  // Os navegadores do canvas (portais) também são navegadores da pasta: o que a pessoa marcou neles
  // vale, e os ligados por corda ao agente são dele.
  const portals = store.portalViews.filter((v) => sameFolder(v.cwd, cwd));
  const inFolder: BrowserView[] = [
    ...store.views.filter((v): v is BrowserView => v.kind === "browser" && sameFolder(v.cwd, cwd)),
    ...portals,
  ];
  // `pick` y `marked` no son sobre la página del agente sino sobre la ATENCIÓN del usuario:
  // lo que marcó lo marcó en la tab que estaba mirando, que es la suya. Mandarlos a la del
  // agente devolvería siempre "no marcaste nada".
  const ofUser = request.op === "pick" || request.op === "marked";
  const chatViewId = owner && (owner.kind === "tab" || owner.kind === "thread")
    ? useChatStore.getState().browser?.viewId
    : undefined;
  const chatView = chatViewId && owner
    ? inFolder.find((v) => v.id === chatViewId && !!v.owner && v.owner.kind === owner.kind && v.owner.id === owner.id)
    : undefined;
  // `pick` e `marked` são para a página que a pessoa está vendo. Se ela está no painel da
  // mesma conversa, os apontamentos pertencem à página compartilhada daquela sessão.
  const browsers = owner && ofUser && chatView
    ? [chatView]
    : owner && !ofUser
      ? inFolder.filter((v) => (v.owner && v.owner.kind === owner.kind && v.owner.id === owner.id) || (portals.includes(v) && linkedToAgent(owner.id, v.id)))
      : inFolder;
  const slot = `${owner && (!ofUser || chatView) ? owner.id : "user"}\u0000${comparablePath(cwd)}`;

  if (browsers.length === 0) {
    // La tab del agente es suya y no se cierra sola; pero el usuario puede cerrarla, y
    // entonces se vuelve a abrir donde estaba. Su trabajo no se pierde por eso.
    const asked = typeof request.url === "string" ? request.url : "";
    const url = request.op === "navigate" ? asked : lastUrl.get(slot) ?? "";
    if (!url) {
      throw new Error(
        owner && !ofUser
          ? "You do not have a browser open in this project yet. Open one with browser_navigate and the project URL."
          : `There is no browser open for ${cwd}. Use browser_navigate with the project URL to open one.`
      );
    }
    // Com o canvas à vista, o navegador que o agente pede nasce LÁ, ao lado dele e ligado por corda (a pessoa o vê
    // trabalhar e pode marcar coisas nele). Fora do canvas, é uma aba, como sempre.
    const inCanvas = owner && !ofUser ? await openPortalFor(owner, url) : null;
    if (inCanvas) {
      lastUsed.set(slot, inCanvas);
      lastUrl.set(slot, url);
      return { host: await waitForHost(inCanvas, 15_000), opened: request.op === "navigate" };
    }
    // Sin robarle el foco a quien está escribiendo en la terminal: la tab aparece en la
    // barra y el agente la usa igual.
    const id = store.openBrowser(cwd, url, { activate: false, owner: owner ?? undefined });
    lastUsed.set(slot, id);
    lastUrl.set(slot, url);
    // `opened` solo si el pedido ERA navegar: si se reabrió para otra cosa, la página
    // todavía tiene que cargar y `runBrowserRequest` la espera.
    return { host: await waitForHost(id, 10_000), opened: request.op === "navigate" };
  }

  const active = browsers.find((v) => v.id === store.activeViewId);
  const remembered = browsers.find((v) => v.id === lastUsed.get(slot));
  // Lo que marcó la persona está en UNA de sus tabs, que no tiene por qué ser la que dejó
  // activa: con dos abiertas, buscar en la de adelante devolvía "no marcaste nada".
  const withMarks = ofUser ? browsers.find((v) => hasMarks(hosts.get(v.id))) : undefined;
  // Para el agente manda LO SUYO, no lo que el usuario tenga activo: si el usuario abre su
  // propia tab del proyecto, el agente no debería empezar a escribir ahí.
  // Quando a tab pedinte é a conversa visível no chat, o painel e o agente precisam operar
  // a mesma página. Fora dela, permanece a tab lembrada do agente para não roubar foco nem
  // misturar sessões paralelas.
  const sharedChatView = chatView ? browsers.find((v) => v.id === chatView.id) : undefined;
  // O painel pode ainda estar publicando o retângulo na primeira renderização; uma tab
  // própria recém-aberta no chat também deve vencer um portal ligado ao mesmo agente.
  const chatOwnedView = owner && !ofUser
    ? browsers.find((v) => !portals.includes(v) && v.owner?.kind === owner.kind && v.owner.id === owner.id)
    : undefined;
  const view = (owner && !ofUser ? sharedChatView ?? chatOwnedView ?? remembered ?? active : withMarks ?? active ?? remembered) ?? browsers[browsers.length - 1];
  lastUsed.set(slot, view.id);
  // Lo que tenga cargado AHORA, haya navegado el agente o el usuario: los dos usan esta
  // página, y al reabrirla tiene que volver a la última.
  if (view.url) lastUrl.set(slot, view.url);
  // Una tab restaurada que nadie miró todavía no está montada: no tiene página. (Um portal monta com o canvas.)
  if (!portals.includes(view)) store.keepMounted(view.id);
  return { host: await waitForHost(view.id, 10_000), opened: false };
}

const str = (r: BrowserRequest, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
const num = (r: BrowserRequest, key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined);
const bool = (r: BrowserRequest, key: string) => r[key] === true;

function required(r: BrowserRequest, key: string): string {
  const value = str(r, key);
  if (value === undefined || value === "") throw new Error(`Falta '${key}'.`);
  return value;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lo que la página logueó como error o aviso y lo que falló en la red mientras duraba una
 * acción. Es lo que convierte "hice click" en "hice click y la API devolvió 500".
 */
async function sideEffects(host: BrowserHost, firstId: number, startedAt: number): Promise<string> {
  // El runtime manda la tanda enseguida después de contestar; se le da un momento para
  // que llegue, y al proxy para anotar lo que la acción disparó.
  await sleep(150);
  const origin = host.proxyOrigin();
  if (origin) await refreshProxyLog(host.viewId, origin).catch(() => undefined);
  const log = debugLogOf(host.viewId);
  const logged = log.console
    .filter((e) => e.id >= firstId && (e.level === "error" || e.level === "warn"))
    .slice(-10)
    .map((e) => `  ${e.level.toUpperCase()} ${e.kind === "exception" ? "Uncaught " : ""}${e.text}${e.source ? `  (${e.source})` : ""}`);
  const failed = requestRows(log)
    // Sin margen hacia atrás: un pedido que disparó la acción empezó (y el proxy lo anotó)
    // después de que empezara; uno de la carga anterior, aunque sea de 20 ms antes, no es suyo.
    .filter((r) => r.at >= startedAt && isFailed(r))
    .slice(-10)
    .map((r) => `  ${r.method} ${r.error ? "ERR" : r.status} ${r.url}${r.error ? ` — ${r.error}` : ""}`);
  const parts: string[] = [];
  if (logged.length) parts.push(`Console durante a ação:\n${logged.join("\n")}`);
  if (failed.length) parts.push(`Pedidos que falharam durante a ação:\n${failed.join("\n")}`);
  return parts.length ? inServerTerms(host, `\n\n${parts.join("\n\n")}`) : "";
}

function cookieTable(rows: CookieRow[]): string {
  if (rows.length === 0) return "(sin cookies)";
  return rows.map((c) => {
    const flags = [
      c.httpOnly === true ? "HttpOnly" : null,
      c.secure ? "Secure" : null,
      c.sameSite ? `SameSite=${c.sameSite}` : null,
      c.path ? `Path=${c.path}` : null,
      c.expiresAt ? `expires ${new Date(c.expiresAt * 1000).toISOString()}` : "session cookie",
      c.sent ? "sent to the server" : "NOT sent in the last request",
      c.visibleToPage ? null : "invisible para JS",
    ].filter(Boolean).join(" · ");
    const value = c.value.length > 120 ? `${c.value.slice(0, 120)}…` : c.value;
    return `${c.name}=${value}\n  ${flags}`;
  }).join("\n");
}

/** Los tiempos de cada orden de página. `wait` y `eval` pueden tardar lo que pidan. */
function timeoutFor(command: PageCommand): number {
  if (command.op === "wait") return Math.min(command.timeoutMs ?? 5000, 15_000) + 3000;
  if (command.op === "eval") return 30_000;
  // A espera por estado do runtime sobe até ~12–14 s numa busca lenta: o tope do canal tem de ser maior.
  if (command.op === "settle") return Math.min(command.ceilingMs ?? 12_000, 14_000) + 4000;
  if (["click", "press", "type", "select", "hover", "drag", "upload", "scroll"].includes(command.op)) return 18_000;
  return 12_000;
}

/** Lo que viene de la página habla en URLs del proxy (`localhost:41234`); el agente las
 *  busca y las escribe en términos del servidor que conoce (`localhost:5173`). */
/** El detalle de un pedido por su id del listado (`p12` si pasó por el proxy, `g5` si lo vio la página). */
async function requestDetailText(host: BrowserHost, id: string): Promise<string> {
  const log = debugLogOf(host.viewId);
  if (id.startsWith("g")) {
    const entry = log.requests.find((e) => `g${e.id}` === id);
    if (!entry) throw new Error(`Não há nenhum pedido ${id}: peça a lista de novo.`);
    const detail = detailFromPage(entry);
    return detailForAgent(detail, egressOriginFor(host.targetOrigin(), detail.url));
  }
  const origin = host.proxyOrigin();
  const seq = Number(id.replace(/^p/, ""));
  if (!origin || !Number.isInteger(seq)) throw new Error(`'${id}' não é um id da lista (são como p12 ou g5).`);
  const raw = await previewRequest(origin, seq);
  if (!raw) throw new Error(`O pedido ${id} não está mais no registro do proxy.`);
  const detail = detailFromProxy(raw);
  return detailForAgent(detail, egressOriginFor(host.targetOrigin(), detail.url));
}

/**
 * Un sitio de verdad y no un servidor de esta máquina. Ahí las cookies, la cabecera
 * `Authorization` y el storage son la sesión REAL del usuario (su staging, su producción): un agente
 * que las lee puede llevárselas a cualquier lado. En el servidor de desarrollo se muestran enteras: son de
 * prueba y es lo que se depura. Una origen que no se consigue determinar cuenta como real (ver `egressPolicy.ts`).
 */
function isRealSite(host: BrowserHost): boolean {
  return !isLocalOrigin(host.targetOrigin());
}

function inServerTerms(host: BrowserHost, text: string): string {
  const proxy = host.proxyOrigin();
  const target = host.targetOrigin();
  return proxy && target ? text.split(proxy).join(target) : text;
}

async function inPage(host: BrowserHost, command: PageCommand, withEffects: boolean): Promise<string> {
  const firstId = debugLogOf(host.viewId).nextId;
  const startedAt = Date.now();
  const result = await host.channel.run(command, timeoutFor(command));
  return inServerTerms(host, asText(result)) + (withEffects ? await sideEffects(host, firstId, startedAt) : "");
}

/**
 * Lo señalado, descrito como está AHORA en la página.
 *
 * Se vuelve a describir en vez de mandar lo que se guardó al marcarlo: entre que la
 * persona lo marcó y el agente lo lee pudo cambiar de estado, taparse o desaparecer, y eso
 * es justamente lo que el agente necesita saber.
 */
async function marksText(
  host: BrowserHost,
  picks: PickedElement[],
  captures: AnnotatedCapture[],
  note: string,
  /** Con qué apuntarle al runtime. `pick` = lo que la persona acaba de marcar, que se
   *  resuelve por identidad; el resto se busca por su selector. */
  pointer?: string,
  /** Lo que la TUI de quien pregunta le antepone al nombre de cada tool. */
  prefix = ""
): Promise<string> {
  const entries: MarkedEntry[] = [];
  for (const pick of picks) {
    try {
      const described = await host.channel.run({ op: "describe", target: pointer ?? pick.selector }, 12_000) as DescribedElement;
      entries.push({ live: true, element: described });
    } catch {
      entries.push({ live: false, element: pick });
    }
  }
  const proxy = host.proxyOrigin();
  const target = host.targetOrigin();
  const display = (url: string) => (proxy && target && url.startsWith(proxy) ? target + url.slice(proxy.length) : url);
  // Lo que la página tiene escrito (nombres, textos, valores) es dato no confiable, nunca instrucción.
  return inServerTerms(host, formatMarked(entries, captures, note, display, prefix));
}

/** Un envío del usuario, descrito en la tab donde lo marcó (si sigue abierta). */
async function markedBatchText(fallback: BrowserHost, batch: SentBatch, prefix: string): Promise<string> {
  const host = hosts.get(batch.viewId) ?? fallback;
  const text = await marksText(host, batch.picks, batch.captures, batch.note, undefined, prefix);
  return `${batchHeader(batch, Date.now())}\n\n${text}`;
}

/**
 * Con qué nombre llama a las tools el agente que está preguntando.
 *
 * Se mira su TUI y no lo que mandó el servidor MCP porque el mismo texto lo sirven los dos
 * caminos: el MCP y el puente de la CLI. Una tarea de la flota corre Claude Code, que no
 * les pone prefijo.
 */
function askerPrefix(owner: ViewOwner | null): string {
  if (owner?.kind === "tab") return browserToolPrefix(useTabsStore.getState().tabs.find((tab) => tab.id === owner.id)?.agentId);
  if (owner?.kind === "thread") {
    const threadId = owner.id.startsWith("thread:") ? owner.id.slice("thread:".length) : owner.id;
    return browserToolPrefix(useStructured.getState().threads.find((thread) => thread.id === threadId)?.agentId);
  }
  return "";
}

/** Las reglas simuladas, para que el agente sepa qué está fingiendo la página. */
function mocksText(mocks: Mock[]): string {
  if (mocks.length === 0) return "Não há nenhuma resposta simulada: o servidor do projeto responde tudo.";
  const lines = mocks.map((m) => {
    const parts = [`${m.method ?? "any method"} ${m.url} → ${m.status}`];
    if (m.delayMs > 0) parts.push(`${m.delayMs} ms de demora`);
    if (m.times !== null) parts.push(`${m.hits}/${m.times} usos`);
    else if (m.hits > 0) parts.push(`${m.hits} uso(s)`);
    return `- ${parts.join(" · ")}  [id=${m.id.slice(0, 8)}]`;
  });
  return `Respuestas simuladas activas:\n${lines.join("\n")}`;
}

async function execute(
  /** La carpeta del proyecto: el límite de lo que el agente puede subir a la página. */
  cwd: string,
  host: BrowserHost,
  request: BrowserRequest,
  opened: boolean,
  /** Quién pregunta: cada agente lee los lotes que le mandaron a él. */
  owner: ViewOwner | null,
  /** O portal que o agente pilota: o `act` manda a ele o progresso parcial (Fase 1.4). */
  portalId?: string
): Promise<string> {
  const op = request.op;
  // Cliques no iframe do desafio são sempre recusados, mesmo antes de a aba ser marcada.
  if (op === "click") {
    await assertNotCaptchaIframeClick(host, request);
  }
  // Aba com captcha ativo: bloqueia qualquer ação interativa e instrui o agente a chamar browser_wait_human.
  const activeCaptcha = getCaptchaHandoffForView(host.viewId);
  if (activeCaptcha && CAPTCHA_BLOCKED_OPS.has(op)) {
    return captchaBlockedJson(activeCaptcha.id);
  }
  switch (op) {
    case "navigate": {
      const url = required(request, "url");
      const firstId = debugLogOf(host.viewId).nextId;
      const startedAt = Date.now();
      // Recién abierta, la tab ya está cargando esta misma URL: pedirla otra vez sería
      // cargarla dos veces.
      const mark = opened ? 0 : host.loadCount();
      if (!opened) await host.navigate(url);
      const loaded = await host.waitForLoad(mark, 20_000);
      const head = loaded
        ? `Loaded ${host.currentUrl()}`
        : `The page did not report finishing the load within 20 s (${host.currentUrl()}). It may still be loading, or it may not be going through the ADE AGS proxy.`;
      const effects = await sideEffects(host, firstId, startedAt);
      const detected = await inspectCaptcha(host, owner, portalId);
      const captchaNote = detected
        ? `\n\n${captchaBlockedJson(detected.id)}`
        : "";
      return head + effects + captchaNote;
    }
    case "history": {
      const action = required(request, "action");
      if (action !== "back" && action !== "forward" && action !== "reload") throw new Error("action es back, forward o reload.");
      const mark = host.loadCount();
      const before = host.currentUrl();
      host.history(action);
      // Atrás en una SPA no recarga el documento: se espera un poco y se informa dónde quedó.
      const loaded = await host.waitForLoad(mark, action === "reload" ? 20_000 : 1500);
      const url = host.currentUrl();
      const detected = await inspectCaptcha(host, owner, portalId);
      const captchaNote = detected ? `\n\n${captchaBlockedJson(detected.id)}` : "";
      return (loaded || url !== before ? `Ahora en ${url}` : `Sigue en ${url} (no había a dónde ir, o la página no cambió).`) + captchaNote;
    }
    case "resize": {
      // El táctil se decide antes de medir: prenderlo cambia qué reglas aplican, y un
      // layout medido con las de escritorio no sería el del teléfono.
      let touch = host.touch();
      if (request.touch !== undefined) {
        touch = bool(request, "touch");
      } else if (bool(request, "reset")) {
        touch = false;
      } else {
        // Elegir "phone" y que siga habiendo hover sería emular medio teléfono. Se puede
        // apagar con `touch: false`, que es lo que sirve para comparar las dos.
        const preset = str(request, "preset");
        const kind = preset ? presetById(preset)?.kind : undefined;
        if (kind) touch = kind === "phone" || kind === "tablet";
      }

      if (bool(request, "reset")) {
        host.setViewport(null);
      } else {
        const preset = str(request, "preset");
        const fromPreset = preset ? presetById(preset) : undefined;
        if (preset && !fromPreset) {
          throw new Error(`Não há nenhum preset '${preset}'. Há: ${VIEWPORT_PRESETS.map((p) => `${p.id} (${p.width}×${p.height})`).join(", ")}`);
        }
        const width = num(request, "width") ?? fromPreset?.width;
        const height = num(request, "height") ?? fromPreset?.height ?? host.viewport()?.height ?? 900;
        if (width === undefined) throw new Error("Pass width (and height), a preset, or reset.");
        host.setViewport(clampViewport({ width, height }));
      }

      let touchNote = "";
      if (touch !== host.touch()) {
        const applied = await host.setTouch(touch) as { note?: string } | null;
        touchNote = applied?.note ? `\n${applied.note}` : "";
      }
      // Que la página reciba el `resize` y reacomode antes de medirla.
      await sleep(400);
      return await inPage(host, { op: "layout" }, false) + touchNote;
    }
    case "console": {
      const level = str(request, "level");
      const { text, next } = consoleForAgent(debugLogOf(host.viewId), {
        since: num(request, "since"),
        level: level === "errors" || level === "warnings" ? level : "all",
        limit: num(request, "limit"),
      });
      return `${inServerTerms(host, text)}\n\n[cursor: ${next} — pasá since=${next} para ver solo lo que llegue después]`;
    }
    case "network": {
      // La red se anota solo con el panel de debug abierto (para no cargar la app con lo
      // que nadie mira): si estaba cerrado no hay nada que leer, y se prende desde ahora.
      if (!host.debugOpen()) {
        host.openNetworkDebug();
        return "Network recording was off: ADE AGS only records network traffic while the browser's "
          + "debug panel is open, and it was closed. It is open now and recording from this point on. "
          + "Reload the page or repeat the action you care about, then call this tool again.";
      }
      const origin = host.proxyOrigin();
      if (origin) await refreshProxyLog(host.viewId, origin);
      const wanted = str(request, "request");
      if (wanted) return inServerTerms(host, await requestDetailText(host, wanted.replace(/^\[|\]$/g, "")));
      const { text, next } = networkForAgent(requestRows(debugLogOf(host.viewId)), {
        since: num(request, "since"),
        failedOnly: bool(request, "failed_only"),
        limit: num(request, "limit"),
      });
      return `${inServerTerms(host, text)}\n\n[cursor: ${next} — pasá since=${next} para ver solo lo que llegue después; `
        + `request=<id entre corchetes> para ver cabeceras, cuerpos y tiempos de uno]`;
    }
    case "cookies": {
      const action = str(request, "action") ?? "list";
      if (action === "set") {
        await host.channel.run({
          op: "cookies", action: "set", name: required(request, "name"), value: str(request, "value") ?? "",
          path: str(request, "path"), maxAge: num(request, "max_age"),
        });
      } else if (action === "delete") {
        await host.channel.run({ op: "cookies", action: "delete", name: required(request, "name"), path: str(request, "path") });
      } else if (action !== "list") {
        throw new Error("action es list, set o delete.");
      }
      const page = await host.channel.run({ op: "cookies", action: "list" }) as { cookies: { name: string; value: string }[] };
      const origin = host.proxyOrigin();
      const report = origin ? await previewCookies(origin).catch(() => null) : null;
      const rows = mergeCookies(page.cookies, report);
      // En un sitio de verdad, la sesión real del usuario: se dice qué cookies hay y cómo
      // están configuradas, no su valor (ver `isRealSite`).
      if (!isRealSite(host)) return cookieTable(rows);
      const siteOrigin = host.targetOrigin();
      return cookieTable(rows.map((row) => ({ ...row, value: redactForAgent("cookie", siteOrigin, row.value) })))
        + "\n\n(Values hidden: this is a real site, not a local dev server, so these cookies are the user's own session.)";
    }
    case "storage": {
      const action = str(request, "action") ?? "list";
      const area = str(request, "area");
      const storageArea = (): StorageArea => {
        if (area !== "local" && area !== "session") throw new Error("area es local o session.");
        return area;
      };
      if (action === "list") {
        // En un sitio real, solo claves y tamaños: el valor del storage puede ser la sesión del usuario (AGENTS.md §2.3).
        const real = isRealSite(host);
        const listed = await inPage(host, { op: "storage", action: "list", values: !real }, false);
        return real ? `${listed}\n\n(Values hidden: this is a real site, so the storage is the user's own session.)` : listed;
      }
      if (action === "set") return inPage(host, { op: "storage", action: "set", area: storageArea(), key: required(request, "key"), value: str(request, "value") ?? "" }, true);
      if (action === "remove") return inPage(host, { op: "storage", action: "remove", area: storageArea(), key: required(request, "key") }, true);
      if (action === "clear") return inPage(host, { op: "storage", action: "clear", area: storageArea() }, true);
      throw new Error("action es list, set, remove o clear.");
    }
    case "pick": {
      const seconds = Math.min(Math.max(num(request, "timeout_s") ?? 120, 10), 600);
      const picked = await host.requestPick(seconds * 1000);
      if (!picked) {
        throw new Error("The user marked nothing: they cancelled with Escape, or the wait timed out.");
      }
      return marksText(host, [picked], [], "", "pick", askerPrefix(owner));
    }
    case "marked": {
      // Por id, que es lo que lleva el aviso: no hay forma de leer lo que le marcaron a
      // otro, ni de confundir dos envíos. Sin id, el último que le hayan mandado a quien
      // pregunta.
      const asking = owner?.id ?? null;
      const prefix = askerPrefix(owner);
      const wanted = str(request, "id");
      const batch = wanted ? batchById(wanted) : batchesFor(asking ?? "")[0];

      if (batch) {
        if (asking && batch.agentId !== asking) {
          throw new Error(`${batch.id} is not yours: the user sent it to another agent. Ask them to send you yours.`);
        }
        const text = await markedBatchText(host, batch, prefix);
        consumeMarks(batch.id);
        return text;
      }
      if (wanted) {
        throw new Error(
          `There is nothing under ${wanted}. Either you already read it —each one is served once— or the user has not sent it yet.`
        );
      }
      const pending = host.marks();
      if (pending) {
        const text = await marksText(host, pending.picks, pending.captures, pending.note, undefined, prefix);
        return `The user has this marked right now (still in their panel, not sent to anyone yet):\n\n${text}`;
      }
      const others = pendingCount();
      throw new Error(
        others > 0
          ? `Nothing is addressed to you: the ${others} batch(es) waiting were sent to another agent. Ask the user to send you theirs, or use ${prefix}browser_pick.`
          : `The user has not marked anything in the browser yet. Ask them for it with ${prefix}browser_pick, or wait until they use the Mark button.`
      );
    }
    case "mock": {
      const origin = host.proxyOrigin();
      if (!origin) throw new Error("No page is loaded yet, so there is no server whose responses could be faked.");
      const action = str(request, "action") ?? "add";
      if (action === "clear") {
        const gone = await previewClearMocks(origin, str(request, "id"));
        return gone > 0 ? `Removed ${gone} rule(s).` : "There were no rules to remove.";
      }
      if (action === "add") {
        await previewAddMock(origin, {
          url: required(request, "url"),
          method: str(request, "method")?.toUpperCase() ?? null,
          status: num(request, "status") ?? 200,
          body: str(request, "body") ?? "",
          contentType: str(request, "content_type") ?? null,
          delayMs: num(request, "delay_ms") ?? 0,
          times: num(request, "times") ?? null,
        });
      } else if (action !== "list") {
        throw new Error("action is add, list or clear.");
      }
      return mocksText(await previewListMocks(origin));
    }
    case "describe": {
      // Con el mismo formato que lo que marca la persona: un modelo lee mejor seis líneas
      // rotuladas que el JSON entero con sus llaves.
      const described = await host.channel.run(
        { op: "describe", target: required(request, "target") }, 12_000
      ) as DescribedElement;
      return inServerTerms(host, formatElement({ live: true, element: described }, 1, (url) => url));
    }
    case "screenshot": {
      // Con id y con el nombre de quien la pidió: dos agentes fotografiando la misma página
      // dejan dos archivos que se distinguen por la ruta, sin mirar adentro.
      const id = newMarkId("s");
      const who = owner ? `${owner.label}-${id}` : id;
      const path = await host.screenshot(who);
      const forWhom = owner ? ` for you (${owner.label})` : "";
      return `Screenshot ${id} of ${host.currentUrl()}${forWhom} saved to:\n${path}\n\n`
        + "Open it with your file tools. It is what the tab shows right now, not the whole document.";
    }
    case "drag":
      return inPage(host, { op: "drag", from: required(request, "from"), to: required(request, "to") }, true);
    case "upload": {
      // Solo archivos del proyecto: la página que los recibe puede ser cualquiera.
      const file = await previewReadUpload(required(request, "path"), cwd);
      return inPage(host, {
        op: "upload", target: required(request, "target"), name: file.name, mime: file.mime, data: file.data,
      }, true);
    }
    case "dialogs": {
      // Aceitar um diálogo por conta própria é o que a app não deixa: a pessoa autoriza cada um na app (ver `dialogPolicy.ts`).
      const action = str(request, "action");
      if (action === "accept") {
        throw new Error("Aceitar um diálogo é decisão da pessoa: a página pergunta e ela responde na app. Peça a ação de novo depois que ela autorizar.");
      }
      if (action && action !== "dismiss") throw new Error("action é dismiss, ou nada para ver os diálogos.");
      return inPage(host, { op: "dialogs" }, false);
    }
    case "snapshot": return inPage(host, { op: "snapshot", all: bool(request, "full") }, false);
    case "layout": return inPage(host, { op: "layout" }, false);
    case "performance": return inPage(host, { op: "performance" }, false);
    case "click": {
      const out = await inPage(host, { op: "click", target: required(request, "target") }, true);
      const detected = await inspectCaptcha(host, owner, portalId);
      return detected ? `${out}\n\n${captchaBlockedJson(detected.id)}` : out;
    }
    case "hover": return inPage(host, { op: "hover", target: required(request, "target") }, true);
    case "type":
      return inPage(host, {
        op: "type", target: required(request, "target"), text: str(request, "text") ?? "",
        clear: bool(request, "clear"), submit: bool(request, "submit"),
      }, true);
    case "press": return inPage(host, { op: "press", key: required(request, "key"), target: str(request, "target") }, true);
    case "select": return inPage(host, { op: "select", target: required(request, "target"), value: required(request, "value") }, true);
    case "scroll":
      return inPage(host, {
        op: "scroll", target: str(request, "target"), dy: num(request, "dy"),
        to: str(request, "to") === "top" ? "top" : str(request, "to") === "bottom" ? "bottom" : undefined,
      }, false);
    case "wait":
      return inPage(host, {
        op: "wait", text: str(request, "text"), selector: str(request, "selector"),
        gone: bool(request, "gone"), idle: bool(request, "idle"), timeoutMs: num(request, "timeout_ms"),
      }, false);
    case "eval": return inPage(host, { op: "eval", code: required(request, "code") }, true);
    case "reset": {
      // Começar do zero no site aberto: cookies, localStorage e sessionStorage da página atual e o livro-razão dos `act`
      // deste portal. É o que o bench faz antes de cada rodada (J1): sem isso o carrinho da rodada anterior continuava lá e
      // o «adicionar ao carrinho» da SauceDemo nunca era medido (0 de 32 rodadas). Destrói estado, não lê: nada sai daqui.
      // Apagar a sessão de um site de verdade é decisão da pessoa (AGENTS.md §2.3): ela confirma na app antes.
      // Num servidor local não se pergunta: o bench roda reset a cada rodada, e lá não há sessão do usuário.
      if (isRealSite(host) && !(await askPersonAboutReset(host.targetOrigin()))) {
        return "Reset cancelado: a pessoa não confirmou. Nada foi apagado.";
      }
      // Cada etapa registra o próprio erro: um reset que falhou não pode parecer um reset que deu certo.
      const failures: string[] = [];
      let cookieCount = 0;
      try {
        const page = await host.channel.run({ op: "cookies", action: "list" }) as { cookies: { name: string }[] };
        cookieCount = page.cookies?.length ?? 0;
        for (const cookie of page.cookies ?? []) {
          try {
            await host.channel.run({ op: "cookies", action: "delete", name: cookie.name });
          } catch (cause) {
            failures.push(`cookie ${cookie.name}: ${errorText(cause)}`);
          }
        }
      } catch (cause) {
        failures.push(`lista de cookies: ${errorText(cause)}`);
      }
      for (const area of ["local", "session"] as const) {
        try {
          await inPage(host, { op: "storage", action: "clear", area }, false);
        } catch (cause) {
          failures.push(`${area}Storage: ${errorText(cause)}`);
        }
      }
      forgetLedger(host.viewId);
      if (failures.length > 0) {
        const detail = failures.join("; ");
        // A pessoa fica sabendo na app; o agente recebe o mesmo texto. Não se espera o clique: o agente não fica preso a um aviso.
        void tellPersonAboutResetFailure(detail);
        return `Reset incompleto: ${detail}. O que deu certo foi zerado; o site pode ter restado parcialmente logado.`;
      }
      return `Portal zerado: ${cookieCount} cookie(s), localStorage, sessionStorage e o histórico dos act. Recarregue a página (navigate) para o site começar do zero.`;
    }
    case "act": {
      const goal = required(request, "goal");
      const fills = Array.isArray(request.fills) ? request.fills.filter((f): f is string => typeof f === "string") : [];
      // `--expect`: o que prova o sucesso, conferido por código (Fase 5). Um `--expect` que não se entende recusa ANTES de agir.
      const expects = Array.isArray(request.expects) ? request.expects.filter((e): e is string => typeof e === "string" && e.trim() !== "") : [];
      const syntax = parseExpectations(expects).errors;
      if (syntax.length > 0) throw new Error(syntax.join(" "));
      const endMeasure = beginWindowMeasure();
      const waits: string[] = [];
      const ledger = ledgerOf(host.viewId);
      ledger.beginAct(goal);
      const parsedExpects = parseExpectations(expects).expects;
      // Os `--expect` conferidos pelo piloto durante o `act` (J3/J5), na página INTEIRA como na conferência final.
      const expectsMet = parsedExpects.length === 0 ? undefined : async (seen?: ParsedPage): Promise<boolean> => {
        const page = seen ?? parseSnapshot(String(await inPage(host, { op: "snapshot", all: true, inView: false }, false)));
        return parsedExpects.every((e) => checkExpectation(e, page).ok);
      };
      const deps = { ...pilotDeps(host, waits, ledger), expectsMet };
      const piloted = portalId ? withProgress(deps, backendSink(portalId)) : deps;
      let result: Awaited<ReturnType<typeof runPilot>> | undefined;
      try {
        result = await runPilot(goal, fills, num(request, "steps"), piloted);
      } finally {
        // Mesmo um `act` que falhou deixa o que já fez no livro-razão: é o que evita repetir a ação no seguinte.
        deps.finish(result?.finalSnapshot ?? null);
      }
      // O resumo final traz o objetivo e a região principal antes do menu (O4), em vez do começo da página.
      const text = formatResult(goal, { ...result, window: await endMeasure(), finalSnapshot: summarizeSnapshot(result.finalSnapshot, goal) });
      return verifyAct(host, waitsReport(text, waits), goal, result.outcome, expects);
    }
    default:
      throw new Error(`O navegador não sabe fazer '${op}'.`);
  }
}

/** Atiende un pedido de un agente sobre su navegador del proyecto `cwd`. */
export async function runBrowserRequest(
  cwd: string,
  request: BrowserRequest,
  owner: ViewOwner | null = null
): Promise<string> {
  if (request.op === "wait_human") {
    const handoffId = required(request, "handoff");
    const timeoutS = Math.min(Math.max(num(request, "timeout_s") ?? 900, 1), 1800);
    const result = await waitForCaptchaHandoff(handoffId, timeoutS * 1000);
    return JSON.stringify(result);
  }
  const { host, opened } = await hostFor(cwd, request, owner);
  // A troca de viewport é a entrada do aparelho emulado; manter essa prévia visível também
  // evita que a pessoa perca o layout móvel que o agente acabou de abrir.
  if (request.op === "navigate" || request.op === "resize") autoShowAgentBrowser(host.viewId, owner);
  // Una tab que se acaba de montar (restaurada, nunca mirada) todavía está cargando su
  // página: leerla ya diría "no hay página" cuando en un segundo la hay.
  if (request.op !== "navigate" && host.loadCount() === 0 && !(await host.waitForLoad(0, 15_000))) {
    throw new Error("The browser for this project has no page loaded. Use browser_navigate with the project URL.");
  }
  return forAgent(request.op, await execute(cwd, host, request, opened, owner));
}

/** Ops cuyo texto lo escribe la app, no la página: no se marcan como dato no confiable. (`reset` sí: nombra cookies del sitio.) */
const OWN_TEXT_OPS = new Set(["resize", "touch", "wait_human"]);

/**
 * Lo que devuelve `execute` sale hacia el agente marcado como dato de la página (su texto, su DOM, sus pedidos,
 * su consola). Se marca UNA vez, aquí, en la frontera: `marksText` y `markedBatchText` no marcan por su cuenta.
 */
function forAgent(op: string, text: string): string {
  if (OWN_TEXT_OPS.has(op) || CAPTCHA_APP_RESPONSE_RE.test(text)) return text;
  return untrustedData(text);
}

/** El mensaje de un error de cualquier forma que llegue (un `Error`, o un texto del canal). */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Lo que un agente puede hacerle a un portal (un navegador del canvas). Una lista corta a
 * propósito: nada que ejecute código en la página, suba archivos o lea cookies, porque un
 * portal puede estar en cualquier sitio y quien lo maneja es un agente conectado, no el
 * usuario. Para eso están las tools de navegador de la tab del proyecto, con su aprobación.
 */
export const PORTAL_OPS = new Set([
  "navigate", "history", "snapshot", "click", "hover", "type", "press", "select", "scroll",
  "wait", "wait_human", "screenshot", "console", "layout", "act", "reset",
]);

/** Confere o `act` contra a página como ficou (um snapshot completo, não só o que está à vista). Nunca lança: sem leitura, o relatório sai como estava. */
async function verifyAct(host: BrowserHost, report: string, goal: string, outcome: PilotResult["outcome"], expects: string[]): Promise<string> {
  if (outcome === "off" || outcome === "error" || (outcome !== "done" && expects.length === 0)) return report;
  try {
    // Uma página com XHR em voo (filtro, quantidade) ainda não mostra o resultado: espera a rede ociosa antes de conferir.
    try { await inPage(host, { op: "wait", idle: true, timeoutMs: 1_500 }, false); } catch { /* confere com o que há */ }
    const full = await inPage(host, { op: "snapshot", all: true, inView: false }, false);
    return verifyReport(report, goal, outcome, expects, full);
  } catch {
    return report;
  }
}

/** O que o piloto do Jev usa deste navegador: ver `jevPilot.ts`. As ações são as mesmas que o agente faria à mão. */
/**
 * O que a ponte acrescenta ao que o piloto pede: `prior` (as ações dos `act`s anteriores NESTE portal, D6) e `finish` (fecha o
 * `act` no livro-razão). `prior` é opcional no piloto: quem não o conhece o ignora.
 */
export type PilotExtras = { prior: () => PriorAction[]; finish: (finalSnapshot: string | null) => void };

export function pilotDeps(host: BrowserHost, notes: string[] = [], ledger: ActLedger = createLedger()): PilotDeps & PilotExtras {
  // O livro-razão (D6/3.4): cada ação é anotada com a contagem do carrinho de antes e, na leitura seguinte, a de depois.
  let lastPage: ParsedPage | null = null;
  let pendingAction: { what: string; fp: string | null; cartBefore: number | null; near?: string; url?: string } | null = null;
  const closeAction = (page: ParsedPage | null): void => {
    if (!pendingAction) return;
    ledger.record({
      what: pendingAction.what,
      changed: page && pendingAction.fp !== null ? fingerprint(page) !== pendingAction.fp : null,
      cartBefore: pendingAction.cartBefore,
      cartAfter: page ? cartCount(page) : null,
      ...(pendingAction.near ? { near: pendingAction.near } : {}),
      ...(pendingAction.url ? { url: bareUrl(pendingAction.url) } : {}),
      ...(page?.url ? { urlAfter: bareUrl(page.url) } : {}),
    });
    pendingAction = null;
  };
  const openAction = (verb: string, ref: string | null): void => {
    closeAction(null);
    const el = ref ? lastPage?.elements.find((e) => e.ref === ref) : undefined;
    const what = ref === null ? verb : `${verb} ${el ? `${el.role}${el.name ? ` "${el.name}"` : ""}` : ref}`;
    pendingAction = { what, fp: lastPage ? fingerprint(lastPage) : null, cartBefore: lastPage ? cartCount(lastPage) : null, ...(el?.near ? { near: el.near } : {}), ...(lastPage?.url ? { url: lastPage.url } : {}) };
  };
  /** O que a página contou sobre a espera daquele comando (`"waited": "esperou 8,2 s …"`), para o relatório do `act`. */
  const noteWait = (result: string, what: string): void => {
    const waited = /"waited":\s*"([^"]+)"/.exec(result)?.[1];
    if (waited) notes.push(`${what}: ${waited}`);
  };
  /**
   * Depois de uma ação que levou a OUTRA página (o resultado diz `navigated`, mesmo num botão de formulário que não é link),
   * espera ela carregar e assentar antes de o piloto reler: lida cedo demais, a página nova aparece vazia, o Jev acha que
   * nada mudou e para com o objetivo já cumprido. Sem navegação não espera nada (antes a busca e o toque pela foto
   * esperavam 2,5 s à toa em cada passo).
   */
  const landed = async (result: string, loads: number, expected = false): Promise<void> => {
    if (!expected && !/navigated/.test(result)) return;
    const started = Date.now();
    // O runtime esperou a navegação pelo ESTADO (E1) e a página nova já existe quando o resultado diz `navigated`. Aqui se
    // espera ela assentar: carregada, sem pedidos pendentes, DOM quieto (teto de ~12 s se ela ainda está carregando).
    const loaded = await host.waitForLoad(loads, 12_000);
    let settled = "";
    try { settled = await inPage(host, { op: "settle", fast: true, ceilingMs: 12_000 }, false); } catch { /* segue */ }
    const waited = /"waited":\s*"([^"]+)"/.exec(settled)?.[1];
    notes.push(`depois da navegação (${Date.now() - started} ms): ${loaded ? "a página nova carregou" : "a página nova NÃO terminou de carregar em 12 s"}${waited ? `; ${waited}` : ""}`);
  };
  return {
    snapshotAll: () => inPage(host, { op: "snapshot", all: true, inView: false }, false),
    // Um envio de busca pode levar segundos até a página nova existir (a Amazon: ~8 s): se a leitura falha por isso, espera a
    // próxima carga e lê de novo, em vez de abortar o `act` com o que já foi feito.
    snapshot: async () => {
      const loads = host.loadCount();
      for (let attempt = 0; ; attempt++) {
        try {
          const text = await inPage(host, { op: "snapshot", all: false, inView: true }, false);
          const page = parseSnapshot(text);
          closeAction(page);
          lastPage = page;
          return text;
        } catch (e) {
          if (attempt >= 2 || !/n[ãa]o respondeu|cambi[óo]|mudou/i.test(e instanceof Error ? e.message : String(e))) throw e;
          await host.waitForLoad(loads, 10_000);
        }
      }
    },
    // Tudo `fast` e sem coletar console/rede (`withEffects` falso): o piloto lê a página de novo depois de cada passo, e é isso que importa.
    click: async (ref, navigates) => {
      openAction("clicou", ref);
      const loads = host.loadCount();
      const result = await inPage(host, { op: "click", target: ref, fast: true }, false);
      noteWait(result, "clique");
      // Um link carrega outra página, que leva segundos: relê só depois.
      await landed(result, loads, navigates);
      return result;
    },
    type: async (ref, text, submit) => {
      openAction(submit ? "digitou e enviou em" : "digitou em", ref);
      const loads = host.loadCount();
      const result = await inPage(host, { op: "type", target: ref, text, clear: true, submit: !!submit, fast: true }, false);
      noteWait(result, submit ? "digitar e enviar" : "digitar");
      // A busca enviada carrega a página de resultados (ou não, numa busca da própria página): só espera se navegou.
      await landed(result, loads);
      return result;
    },
    select: async (ref, value) => {
      openAction("escolheu em", ref);
      const loads = host.loadCount();
      const result = await inPage(host, { op: "select", target: ref, value, fast: true }, false);
      noteWait(result, "escolher");
      await landed(result, loads);
      return result;
    },
    scroll: () => inPage(host, { op: "scroll", dy: 600, fast: true }, false),
    // O comando já esperou a página assentar por ESTADO (sem navegação em curso, rede ociosa, DOM quieto). A operação `wait`
    // do Jev espera de novo, com teto maior (8 s): é o que ele pede quando vê que os resultados ainda carregam.
    settle: async (thorough) => {
      if (!thorough) return;
      // Uma lista que só muda quando um pedido lento volta (8 s) não pode ser dada por parada: enquanto a leitura diz que ainda
      // há pedido em voo, espera de novo, até ~11 s no total (o `wait` do Jev antes parava em ~3 s e o piloto concluía «sem caminho»).
      const started = Date.now();
      for (let round = 0; round < 4; round++) {
        try {
          const settled = await inPage(host, { op: "settle", fast: true, ceilingMs: 8_000 }, false);
          noteWait(settled, "esperar a página");
          const pending = Number(/"pendingRequests":\s*(\d+)/.exec(settled)?.[1] ?? 0);
          if (pending === 0 || Date.now() - started > 8_000) break;
        } catch { break; /* segue */ }
      }
    },
    pick: (query) => invoke("decision_pick_step", { query }),
    // Abre a conexão com o Jev enquanto a primeira página é lida (só age com o piloto ligado).
    warm: () => { void invoke("decision_preconnect").catch(() => undefined); },
    // A reserva visual: uma foto da página (só se estiver toda à vista) e o toque no ponto que o Jev apontar.
    visual: async (goal, recent, region, marks) => {
      const shot = await host.visualShot(region, marks);
      if (!shot.complete) {
        return { status: "error", found: null, foundProbability: null, center: null, confidence: null, latencyMs: null, reason: `a página não está toda à vista no canvas (cortada pela borda ou coberta por outro painel): a foto sairia errada (${shot.detail ?? "sem medidas"})` };
      }
      return invoke("decision_pick_visual", { query: { goal, recent, imagePath: shot.path, marks: marks?.length ?? 0 } });
    },
    peekAt: async (x, y, second) => inPage(host, { op: "peek", target: `@${x},${y}${second ? "#2" : ""}` }, false),
    // Só o histórico que ainda vale para a página de agora (outra página, ou o carrinho que voltou a 0, não conta).
    prior: () => ledger.prior(lastPage ? fingerprint(lastPage) : null, { url: lastPage?.url, cart: lastPage ? cartCount(lastPage) : null }),
    finish: (finalSnapshot) => {
      closeAction(null);
      ledger.endAct(finalSnapshot ? fingerprint(parseSnapshot(finalSnapshot)) : lastPage ? fingerprint(lastPage) : null);
    },
    clickAt: async (x, y, second) => {
      await assertNotCaptchaIframeClick(host, { op: "click", x, y });
      if (getCaptchaHandoffForView(host.viewId)) {
        throw new Error(CAPTCHA_IFRAME_CLICK_REFUSED);
      }
      openAction(second ? "tocou no outro ícone sem nome ao lado do ponto da foto" : "tocou num ponto da foto", null);
      const loads = host.loadCount();
      const result = await inPage(host, { op: "click", target: `@${x},${y}${second ? "#2" : ""}`, fast: true }, false);
      noteWait(result, "toque pela foto");
      // Um toque pela foto não sabe se é um link: o resultado diz se navegou (senão o piloto julgaria a página antiga).
      await landed(result, loads);
      return result;
    },
  };
}

/**
 * O que a página esperou durante o `act` (E1): cada comando espera por ESTADO, não por tempo, e conta o que viu pendente.
 * Vai antes de «A página agora», para o agente ver quanto durou uma busca lenta e por quê. Sem espera notável, nada muda.
 */
export function waitsReport(text: string, waits: string[]): string {
  if (waits.length === 0) return text;
  const block = `\nESPERA (por estado da página, não por tempo fixo):\n${waits.slice(0, 12).map((w) => `- ${w}`).join("\n")}${waits.length > 12 ? `\n- … mais ${waits.length - 12}` : ""}`;
  const at = text.indexOf("\nA página agora");
  return at < 0 ? text + block : text.slice(0, at) + block + text.slice(at);
}

/** O estado de cada portal pedido (`ags portals`): sem esperar o nó aparecer, para que um portal não desenhado conte como «oculto». */
export function portalStates(ids: string[]): Record<string, PortalStateInfo> {
  const hidden = typeof document !== "undefined" && document.hidden;
  return Object.fromEntries(ids.map((id) => {
    const host = hosts.get(id);
    return [id, portalStateOf(host && { load: host.loadState() }, hidden)];
  }));
}

/** Atiende un pedido de un agente sobre un portal, por su id. */
export async function runPortalRequest(
  portalId: string,
  cwd: string,
  request: BrowserRequest,
  owner: ViewOwner | null = null
): Promise<string> {
  if (!PORTAL_OPS.has(request.op)) {
    throw new Error(`Um portal não aceita '${request.op}'. Aceita: ${[...PORTAL_OPS].join(", ")}.`);
  }
  if (request.op === "wait_human") {
    const handoffId = required(request, "handoff");
    const timeoutS = Math.min(Math.max(num(request, "timeout_s") ?? 900, 1), 1800);
    const result = await waitForCaptchaHandoff(handoffId, timeoutS * 1000);
    return JSON.stringify(result);
  }
  // El nodo monta el navegador al dibujarse; si el canvas todavía no lo hizo (ventana en
  // otra vista), se espera a que aparezca.
  const host = await waitForHost(portalId, 15_000);
  if (request.op !== "navigate" && host.loadCount() === 0 && !(await host.waitForLoad(0, 15_000))) {
    throw new Error("O portal não tem nenhuma página carregada. Comece com `ags portal navigate <portal> <url>`.");
  }
  return forAgent(request.op, await execute(cwd, host, request, false, owner, portalId));
}
