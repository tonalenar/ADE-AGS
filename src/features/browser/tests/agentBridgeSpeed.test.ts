// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const previewWafChallenge = vi.fn<(_origin: string) => Promise<string | null>>();

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  previewWafChallenge: (origin: string) => previewWafChallenge(origin),
}));

const tabs = {
  views: [{ kind: "browser", id: "v-speed", cwd: "/proj", url: "https://site.exemplo.com/" }],
  portalViews: [] as unknown[],
  activeViewId: "v-speed",
  keepMounted: vi.fn(),
  openBrowser: vi.fn(),
};
vi.mock("@/features/tabs/viewStore", () => ({ useViewTabsStore: { getState: () => tabs } }));

import { clearCaptchaState, recheckCaptchaForView, registerBrowserHost, runBrowserRequest, verifyAct, type BrowserHost } from "../agentBridge";

type Command = { op: string; [key: string]: unknown };

function fakeHost(opts: { proxyOrigin?: string | null; viewport?: { width: number; height: number } | null; waitForLoad?: () => Promise<boolean> } = {}) {
  const sent: Command[] = [];
  let loads = 1;
  let viewport = opts.viewport ?? null;
  const host = {
    viewId: "v-speed",
    cwd: "/proj",
    channel: {
      run: async (command: Command) => {
        sent.push(command);
        if (command.op === "captcha") return { url: "https://site.exemplo.com/", title: "Loja", iframes: [] };
        return { ok: true };
      },
    },
    navigate: async () => { loads += 1; },
    history: () => undefined,
    setViewport: (v: { width: number; height: number } | null) => { viewport = v; },
    viewport: () => viewport,
    setTouch: async () => null,
    touch: () => false,
    proxyOrigin: () => opts.proxyOrigin ?? null,
    targetOrigin: () => "https://site.exemplo.com",
    currentUrl: () => "https://site.exemplo.com/",
    loadCount: () => loads,
    loadState: () => ({ loadCount: loads, ready: true, navigatingForMs: null }),
    waitForLoad: opts.waitForLoad ?? (async () => true),
    marks: () => null,
    debugOpen: () => false,
    openNetworkDebug: () => undefined,
  } as unknown as BrowserHost;
  registerBrowserHost(host);
  return { host, sent };
}

const captchaOps = (sent: Command[]) => sent.filter((c) => c.op === "captcha").length;

beforeEach(() => {
  previewWafChallenge.mockReset();
  previewWafChallenge.mockResolvedValue(null);
  clearCaptchaState();
});

afterEach(() => vi.useRealTimers());

describe("ações diretas do agente sem espera fixa à toa", () => {
  it("no motor nativo (sem proxy) uma ação com efeitos não dorme: com o relógio parado ela conclui", async () => {
    vi.useFakeTimers();
    const { sent } = fakeHost();
    // Se `sideEffects` ainda fizesse `sleep(150)`, esta promessa nunca resolveria (o relógio falso não anda).
    await runBrowserRequest("/proj", { op: "click", target: "e1" });
    expect(sent.some((c) => c.op === "click")).toBe(true);
  });

  it("sem proxy não há ida ao Rust pelo desafio WAF", async () => {
    vi.useFakeTimers();
    fakeHost();
    await runBrowserRequest("/proj", { op: "click", target: "e1" });
    expect(previewWafChallenge).not.toHaveBeenCalled();
  });

  it("navigate reaproveita a inspeção de captcha que o evento nav já fez no documento novo", async () => {
    vi.useFakeTimers();
    const made = fakeHost({
      waitForLoad: async () => {
        // O `nav` do documento novo reinspeciona (BrowserTab) antes de a ação seguir.
        await recheckCaptchaForView("v-speed");
        return true;
      },
    });
    await runBrowserRequest("/proj", { op: "navigate", url: "https://site.exemplo.com/b" });
    expect(captchaOps(made.sent)).toBe(1);
  });

  it("um click na mesma página continua conferindo o captcha (uma vez)", async () => {
    vi.useFakeTimers();
    const { sent } = fakeHost();
    await runBrowserRequest("/proj", { op: "click", target: "e1" });
    expect(captchaOps(sent)).toBe(1);
  });
});

describe("resize espera o evento, não 400 ms fixos", () => {
  it("com o tamanho mudado, pede o layout depois do evento resize (teto 400 ms) e não dorme", async () => {
    vi.useFakeTimers();
    const { sent } = fakeHost({ viewport: { width: 1000, height: 800 } });
    await runBrowserRequest("/proj", { op: "resize", width: 390, height: 844 });
    const layout = sent.find((c) => c.op === "layout");
    expect(layout?.afterResize).toMatchObject({ capMs: 400 });
    expect(typeof (layout?.afterResize as { since: number }).since).toBe("number");
  });

  it("com o mesmo tamanho não há evento a esperar: layout simples", async () => {
    vi.useFakeTimers();
    const { sent } = fakeHost({ viewport: { width: 390, height: 844 } });
    await runBrowserRequest("/proj", { op: "resize", width: 390, height: 844 });
    expect(sent.find((c) => c.op === "layout")?.afterResize).toBeUndefined();
  });
});

describe("verifyAct não repete a leitura que o act acabou de fazer", () => {
  const FULL = '- page [url=https://site.exemplo.com/]\n- heading "Carrinho vazio"';

  it("com a leitura inteira à mão, não espera a rede nem lê de novo, e ainda confere o --expect", async () => {
    const { host, sent } = fakeHost();
    const out = await verifyAct(host, "act ok", "esvaziar", "done", ['text:"Carrinho vazio"'], FULL);
    expect(sent).toHaveLength(0);
    expect(out).toContain("act ok");
  });

  it("sem leitura aproveitável, espera a rede ociosa e lê a página inteira uma vez", async () => {
    const { host, sent } = fakeHost();
    await verifyAct(host, "act ok", "esvaziar", "done", [], null);
    expect(sent.map((c) => c.op)).toEqual(["wait", "snapshot"]);
  });
});
