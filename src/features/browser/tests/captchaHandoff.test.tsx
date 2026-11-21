// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const previewWafChallenge = vi.fn<(_origin: string) => Promise<string | null>>();
const previewCaptchaNotify = vi.fn<(_title: string, _body: string) => Promise<boolean>>();
const navigateMock = vi.fn();
const requestUserAttention = vi.fn(() => Promise.resolve());
const activateView = vi.fn();
const setWorkMode = vi.fn();
const focusRef = vi.fn();
const setRightPanel = vi.fn();
const setColumnTabResource = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (!params) return key;
      return Object.entries(params).reduce((acc, [k, v]) => `${acc} ${k}=${v}`, key);
    },
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention }),
  UserAttentionType: { Informational: 2 },
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    previewWafChallenge: (origin: string) => previewWafChallenge(origin),
    previewCaptchaNotify: (title: string, body: string) => previewCaptchaNotify(title, body),
  };
});

const viewStoreState = {
  views: [
    { kind: "browser", id: "v-cap-2", cwd: "/proj", url: "https://conta.exemplo.com/login", owner: { kind: "tab" as const, id: "t1", label: "Claude Code" } },
  ],
  portalViews: [] as { kind: "browser"; id: string; cwd: string; url: string }[],
  activeViewId: "v-cap-2",
  activateView,
  keepMounted: vi.fn(),
  openBrowser: vi.fn(),
};
vi.mock("@/features/tabs/viewStore", () => ({
  useViewTabsStore: { getState: () => viewStoreState },
}));

const canvasStoreState = {
  boards: {} as Record<string, { portals: Record<string, unknown>; nodes: Record<string, unknown>; edges: unknown[] }>,
  modes: {} as Record<string, string>,
};
vi.mock("@/features/canvas/store", () => ({
  useCanvasStore: { getState: () => canvasStoreState },
  setWorkMode: (...args: unknown[]) => setWorkMode(...args),
  canvasActions: { focusRef: (...args: unknown[]) => focusRef(...args) },
  boardKeyOfTab: () => "main|/proj",
  flushSave: vi.fn(),
  windowModeKey: () => "main",
  workModeFor: () => "tabs",
}));

vi.mock("@/features/chat/store", () => ({
  useChatStore: {
    getState: () => ({
      panel: "none",
      thread: null,
      browser: null,
      browserFloating: false,
      columnActive: null,
      columnTabs: [],
    }),
  },
  setRightPanel: (...args: unknown[]) => setRightPanel(...args),
  setColumnTabResource: (...args: unknown[]) => setColumnTabResource(...args),
  toggleChatBrowserFloating: vi.fn(),
}));

vi.mock("@/app/uiStore", () => ({
  useUiStore: { getState: () => ({ chatMode: false, shellMode: "workspace", setShellMode: vi.fn() }) },
  chatShellOn: () => false,
}));

import type { DocumentSnapshot } from "../captcha";
import {
  captchaHandoffOf,
  clearCaptchaState,
  onCaptchaDocumentEvent,
  recheckCaptchaForView,
  registerBrowserHost,
  runBrowserRequest,
  type BrowserHost,
} from "../agentBridge";
import { CaptchaHandoffCard } from "../CaptchaHandoffCard";

let container: HTMLDivElement;
let root: Root;

const CAPTCHA_SNAP: DocumentSnapshot = {
  url: "https://conta.exemplo.com/login",
  title: "Entrar",
  iframes: [{ src: "https://www.google.com/recaptcha/api2/anchor?k=test" }],
};

const CLEAN_SNAP: DocumentSnapshot = {
  url: "https://conta.exemplo.com/dashboard",
  title: "Painel",
  text: "Bem-vindo ao painel",
  iframes: [],
};

function setupHost(viewId: string, getSnap: () => DocumentSnapshot) {
  const watchCalls: boolean[] = [];
  const host = {
    viewId,
    cwd: "/proj",
    channel: {
      run: async (command: { op: string }) => {
        if (command.op === "captcha") return getSnap();
        return { ok: true };
      },
    },
    navigate: async () => undefined,
    history: () => undefined,
    setViewport: () => undefined,
    viewport: () => null,
    setTouch: async () => null,
    touch: () => false,
    proxyOrigin: () => null,
    targetOrigin: () => "https://conta.exemplo.com",
    currentUrl: () => getSnap().url ?? "https://conta.exemplo.com/login",
    loadCount: () => 1,
    loadState: () => ({ loadCount: 1, ready: true, navigatingForMs: null }),
    waitForLoad: async () => true,
    marks: () => null,
    requestPick: async () => null,
    screenshot: async () => "/tmp/shot.png",
    visualShot: async () => ({ path: "/tmp/v.png", complete: true }),
    debugOpen: () => false,
    openNetworkDebug: () => undefined,
    watchCaptcha: (on: boolean) => { watchCalls.push(on); },
  } as unknown as BrowserHost;
  const unregister = registerBrowserHost(host);
  return { host, watchCalls, unregister };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  previewWafChallenge.mockReset();
  previewWafChallenge.mockResolvedValue(null);
  previewCaptchaNotify.mockReset();
  previewCaptchaNotify.mockResolvedValue(true);
  navigateMock.mockReset();
  requestUserAttention.mockReset();
  requestUserAttention.mockResolvedValue(undefined);
  activateView.mockReset();
  setWorkMode.mockReset();
  focusRef.mockReset();
  clearCaptchaState();
  viewStoreState.portalViews = [];
  canvasStoreState.boards = {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
});

describe("entrega de captcha para a pessoa e retomada (C2)", () => {
  it("cartao_aparece_quando_detecta", async () => {
    const { unregister } = setupHost("v-cap-2", () => CAPTCHA_SNAP);
    try {
      await act(async () => {
        root.render(<CaptchaHandoffCard />);
      });
      expect(container.textContent).toBe("");

      // Detecta captcha após carregamento na aba do agente "Claude Code".
      await act(async () => {
        await runBrowserRequest("/proj", { op: "click", target: "#entrar" }, { kind: "tab", id: "t1", label: "Claude Code" });
      });

      const handoff = captchaHandoffOf("v-cap-2");
      expect(handoff).not.toBeNull();
      expect(container.textContent).toContain("Claude Code");
      expect(container.textContent).toContain("conta.exemplo.com");
      expect(previewCaptchaNotify).toHaveBeenCalledTimes(1);

      const buttons = Array.from(container.querySelectorAll("button"));
      const solveBtn = buttons.find((b) => b.textContent?.includes("browser.captcha.solveNow"));
      expect(solveBtn).toBeDefined();

      await act(async () => {
        solveBtn!.click();
      });
      expect(activateView).toHaveBeenCalledWith("v-cap-2");
      expect(navigateMock).toHaveBeenCalledWith("/workspace");
    } finally {
      unregister();
    }
  });

  it("resolver_libera_e_wait_human_retorna_resolved", async () => {
    let snap: DocumentSnapshot = CAPTCHA_SNAP;
    const { watchCalls, unregister } = setupHost("v-cap-2", () => snap);
    try {
      await act(async () => {
        root.render(<CaptchaHandoffCard />);
      });

      await act(async () => {
        await runBrowserRequest("/proj", { op: "click", target: "#entrar" }, { kind: "tab", id: "t1", label: "Claude Code" });
      });
      const handoff = captchaHandoffOf("v-cap-2");
      expect(handoff).not.toBeNull();
      expect(watchCalls).toContain(true);

      // Inicia browser_wait_human: fica pendente por evento, sem polling.
      let resolvedValue: string | null = null;
      const waiting = runBrowserRequest("/proj", { op: "wait_human", handoff: handoff!.id, timeout_s: 900 })
        .then((res) => { resolvedValue = res; return res; });

      await Promise.resolve();
      expect(resolvedValue).toBeNull();

      // A pessoa resolve o captcha e a página muda (evento de mutação ou navegação).
      snap = CLEAN_SNAP;
      await act(async () => {
        await onCaptchaDocumentEvent("v-cap-2", CLEAN_SNAP);
      });

      const result = await waiting;
      expect(JSON.parse(result)).toEqual({ resolved: true });
      expect(captchaHandoffOf("v-cap-2")).toBeNull();
      expect(container.textContent).toBe("");
      expect(watchCalls[watchCalls.length - 1]).toBe(false);

      // Depois de resolvido, o agente volta a poder clicar normalmente.
      const nextClick = await runBrowserRequest("/proj", { op: "click", target: "#continuar" });
      expect(nextClick).not.toContain('"blocked":"captcha"');
    } finally {
      unregister();
    }
  });

  it("cancelar_retorna_cancelled", async () => {
    const { unregister } = setupHost("v-cap-2", () => CAPTCHA_SNAP);
    try {
      await act(async () => {
        root.render(<CaptchaHandoffCard />);
      });

      await act(async () => {
        await runBrowserRequest("/proj", { op: "click", target: "#entrar" }, { kind: "tab", id: "t1", label: "Codex" });
      });
      const handoff = captchaHandoffOf("v-cap-2");
      expect(handoff).not.toBeNull();

      const waiting = runBrowserRequest("/proj", { op: "wait_human", handoff: handoff!.id });

      const cancelBtn = Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("browser.captcha.cancel"));
      expect(cancelBtn).toBeDefined();

      await act(async () => {
        cancelBtn!.click();
      });

      const result = await waiting;
      expect(JSON.parse(result)).toEqual({ cancelled: true });
      expect(captchaHandoffOf("v-cap-2")).toBeNull();
      expect(container.textContent).toBe("");
    } finally {
      unregister();
    }
  });

  it("expira_no_timeout", async () => {
    vi.useFakeTimers();
    const { unregister } = setupHost("v-cap-2", () => CAPTCHA_SNAP);
    try {
      // Dispara detecção via evento de carga (sem depender de sideEffects com timer real).
      await recheckCaptchaForView("v-cap-2");
      const handoff = captchaHandoffOf("v-cap-2");
      expect(handoff).not.toBeNull();

      let settled: string | null = null;
      const waiting = runBrowserRequest("/proj", { op: "wait_human", handoff: handoff!.id })
        .then((res) => { settled = res; return res; });

      // Padrão de 900 s (15 min): ainda pendente com 899 s.
      await vi.advanceTimersByTimeAsync(899_000);
      expect(settled).toBeNull();

      // Ao completar 900 s, expira sem polling nem espera real.
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waiting;
      expect(JSON.parse(result)).toEqual({ expired: true });
      expect(captchaHandoffOf("v-cap-2")).toBeNull();
    } finally {
      unregister();
    }
  });
});
