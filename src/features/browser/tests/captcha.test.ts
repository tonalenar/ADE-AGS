// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewWafChallenge = vi.fn<(_origin: string) => Promise<string | null>>();

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    previewWafChallenge: (origin: string) => previewWafChallenge(origin),
  };
});

const tabs = {
  views: [{ kind: "browser", id: "v-cap", cwd: "/proj", url: "https://site.exemplo.com/login", owner: undefined as undefined | { kind: "tab"; id: string; label: string } }],
  portalViews: [] as { kind: "browser"; id: string; cwd: string; url: string }[],
  activeViewId: "v-cap",
  keepMounted: vi.fn(),
  openBrowser: vi.fn(),
};
vi.mock("@/features/tabs/viewStore", () => ({ useViewTabsStore: { getState: () => tabs } }));

import { detectCaptcha, snapshotFromDocument, type DocumentSnapshot } from "../captcha";
import { captchaHandoffOf, clearCaptchaState, registerBrowserHost, runBrowserRequest, type BrowserHost } from "../agentBridge";
import { loadRuntime } from "./runtimeHarness";

const FIXTURE_RECAPTCHA = `
  <!doctype html>
  <html><head><title>Entrar</title></head>
  <body>
    <form>
      <input id="email" type="email" />
      <div class="g-recaptcha">
        <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></iframe>
      </div>
      <button id="submit" type="submit">Entrar</button>
    </form>
  </body></html>
`;

const FIXTURE_HCAPTCHA = `
  <!doctype html>
  <html><head><title>Cadastro</title></head>
  <body>
    <div class="h-captcha">
      <iframe src="https://newassets.hcaptcha.com/captcha/v1/abcdef/static/hcaptcha.html#frame=checkbox"></iframe>
    </div>
  </body></html>
`;

const FIXTURE_TURNSTILE = `
  <!doctype html>
  <html><head><title>Checkout</title></head>
  <body>
    <div class="cf-turnstile">
      <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/auto/normal"></iframe>
    </div>
  </body></html>
`;

const FIXTURE_CLOUDFLARE_EN = `
  <!doctype html>
  <html><head><title>Just a moment...</title></head>
  <body>
    <form id="challenge-form" action="/?__cf_chl_f_tk=123" method="POST">
      <p>Checking if the site connection is secure</p>
    </form>
  </body></html>
`;

const FIXTURE_CLOUDFLARE_PT = `
  <!doctype html>
  <html><head><title>Um momento…</title></head>
  <body>
    <form id="challenge-form" action="/?__cf_chl_f_tk=456" method="POST">
      <p>Verificando a segurança da conexão</p>
    </form>
  </body></html>
`;

const FIXTURE_NORMAL = `
  <!doctype html>
  <html><head><title>Minha Conta — Loja</title></head>
  <body>
    <main>
      <h1>Bem-vindo</h1>
      <form id="login-form">
        <label for="user">E-mail</label>
        <input id="user" type="email" />
        <button id="submit" type="submit">Entrar</button>
      </form>
      <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
    </main>
  </body></html>
`;

function parseFixture(html: string, wafChallengeAction?: string | null): DocumentSnapshot {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return snapshotFromDocument(doc, wafChallengeAction);
}

type Command = { op: string; [key: string]: unknown };

function fakeHost(
  viewId: string,
  url: string,
  answer: (command: Command) => unknown,
  opts: { proxyOrigin?: string | null; targetOrigin?: string | null } = {},
) {
  const sent: Command[] = [];
  let loads = 1;
  const host = {
    viewId,
    cwd: "/proj",
    channel: {
      run: async (command: Command) => {
        sent.push(command);
        return answer(command);
      },
    },
    navigate: async () => {
      loads += 1;
    },
    history: () => undefined,
    setViewport: () => undefined,
    viewport: () => null,
    setTouch: async () => null,
    touch: () => false,
    proxyOrigin: () => opts.proxyOrigin ?? null,
    targetOrigin: () => opts.targetOrigin ?? new URL(url).origin,
    currentUrl: () => url,
    loadCount: () => loads,
    loadState: () => ({ loadCount: loads, ready: true, navigatingForMs: null }),
    waitForLoad: async () => true,
    marks: () => null,
    requestPick: async () => null,
    screenshot: async () => "/tmp/shot-captcha.png",
    visualShot: async () => ({ path: "/tmp/visual.png", complete: true }),
    debugOpen: () => false,
    openNetworkDebug: () => undefined,
  } as unknown as BrowserHost;
  registerBrowserHost(host);
  return { host, sent };
}

beforeEach(() => {
  // Evita que o happy-dom tente buscar pela rede o `src` dos <iframe> das fixtures HTML.
  const happy = (window as unknown as {
    happyDOM?: { settings?: { disableIframePageLoading?: boolean; disableCSSFileLoading?: boolean; handleDisabledFileLoadingAsSuccess?: boolean } };
  }).happyDOM;
  if (happy?.settings) {
    happy.settings.disableIframePageLoading = true;
    happy.settings.disableCSSFileLoading = true;
    happy.settings.handleDisabledFileLoadingAsSuccess = true;
  }
  previewWafChallenge.mockReset();
  previewWafChallenge.mockResolvedValue(null);
  clearCaptchaState();
  tabs.views[0] = { kind: "browser", id: "v-cap", cwd: "/proj", url: "https://site.exemplo.com/login", owner: undefined };
  tabs.activeViewId = "v-cap";
});

describe("detecção de captcha (C1)", () => {
  it("detecta_recaptcha_hcaptcha_turnstile_cloudflare", () => {
    expect(detectCaptcha(parseFixture(FIXTURE_RECAPTCHA))).toBe("recaptcha");
    expect(detectCaptcha(parseFixture(FIXTURE_HCAPTCHA))).toBe("hcaptcha");
    expect(detectCaptcha(parseFixture(FIXTURE_TURNSTILE))).toBe("turnstile");
    expect(detectCaptcha(parseFixture(FIXTURE_CLOUDFLARE_EN))).toBe("cloudflare");
    expect(detectCaptcha(parseFixture(FIXTURE_CLOUDFLARE_PT))).toBe("cloudflare");
    expect(detectCaptcha(parseFixture(FIXTURE_NORMAL, "captcha"))).toBe("aws-waf");
    expect(detectCaptcha(parseFixture(FIXTURE_NORMAL, "challenge"))).toBe("aws-waf");
    expect(detectCaptcha({ title: "Verificação", text: "Verifique que você é humano para continuar." })).toBe("generic");
  });

  it("pagina_normal_nao_detecta", () => {
    expect(detectCaptcha(parseFixture(FIXTURE_NORMAL))).toBeNull();
    expect(detectCaptcha({ title: "Dashboard", text: "Resumo de vendas do mês", iframes: [] })).toBeNull();
  });

  it("aba_com_captcha_bloqueia_click_type_fill", async () => {
    const captchaSnap = parseFixture(FIXTURE_RECAPTCHA);
    const { sent } = fakeHost("v-cap", "https://site.exemplo.com/login", (command) => {
      if (command.op === "captcha") return captchaSnap;
      return { ok: true };
    });

    await runBrowserRequest("/proj", { op: "navigate", url: "https://site.exemplo.com/login" });

    const handoff = captchaHandoffOf("v-cap");
    expect(handoff).not.toBeNull();
    expect(handoff?.kind).toBe("recaptcha");
    expect(typeof handoff?.id).toBe("string");
    expect(typeof handoff?.since).toBe("number");

    sent.length = 0;

    const blockedRequests: Record<string, unknown>[] = [
      { op: "click", target: "#submit" },
      { op: "type", target: "#email", text: "ana@exemplo.com" },
      { op: "press", key: "Enter" },
      { op: "drag", from: "#a", to: "#b" },
      { op: "select", target: "#country", value: "BR" },
      { op: "fillLogin", id: "login-1", submit: true },
      { op: "eval", code: "document.title" },
    ];

    for (const req of blockedRequests) {
      const out = await runBrowserRequest("/proj", req as { op: string });
      expect(JSON.parse(out)).toEqual({ blocked: "captcha", handoff: handoff!.id });
    }

    // Nenhuma dessas ações chegou a ser enviada para a página.
    expect(sent.filter((c) => c.op !== "captcha")).toEqual([]);
  });

  it("leitura_continua_permitida", async () => {
    const captchaSnap = parseFixture(FIXTURE_CLOUDFLARE_EN);
    fakeHost("v-cap", "https://site.exemplo.com/login", (command) => {
      if (command.op === "captcha") return captchaSnap;
      if (command.op === "snapshot") return "title: Just a moment...";
      if (command.op === "describe") {
        return {
          ref: "u1",
          role: "form",
          name: "challenge",
          tag: "form",
          selector: "#challenge-form",
          states: [],
          text: "Checking if the site connection is secure",
          components: [],
          ancestors: [],
          attributes: { id: "challenge-form" },
          classes: [],
          box: { x: 0, y: 0, width: 300, height: 100, visible: true, covered: null },
          viewport: { width: 1280, height: 800 },
          styles: { display: "block", position: "static", color: "", background: "", font: "", padding: "", margin: "", border: "", zIndex: "", overflow: "" },
          html: "<form id=\"challenge-form\"></form>",
          url: "https://site.exemplo.com/login",
        };
      }
      return { ok: true };
    });

    await runBrowserRequest("/proj", { op: "navigate", url: "https://site.exemplo.com/login" });
    expect(captchaHandoffOf("v-cap")?.kind).toBe("cloudflare");

    const shot = await runBrowserRequest("/proj", { op: "screenshot" });
    expect(shot).toContain("/tmp/shot-captcha.png");

    const snap = await runBrowserRequest("/proj", { op: "snapshot" });
    expect(snap).toContain("Just a moment...");

    const desc = await runBrowserRequest("/proj", { op: "describe", target: "#challenge-form" });
    expect(desc).toContain("#challenge-form");
  });

  it("clique_no_iframe_do_desafio_sempre_recusado", async () => {
    const iframeSnap: DocumentSnapshot = {
      title: "Entrar",
      iframes: [
        {
          src: "https://www.google.com/recaptcha/api2/anchor?k=123",
          title: "reCAPTCHA",
          left: 100,
          top: 100,
          right: 400,
          bottom: 180,
        },
      ],
    };
    // Mesmo ANTES de qualquer navegação/marcação da aba, clicar no iframe do desafio é recusado.
    const { sent } = fakeHost("v-cap", "https://site.exemplo.com/login", (command) => {
      if (command.op === "captcha") return iframeSnap;
      return { clicked: "errado" };
    });

    await expect(
      runBrowserRequest("/proj", { op: "click", target: 'iframe[src*="recaptcha"]' })
    ).rejects.toThrow(/captcha/i);

    await expect(
      runBrowserRequest("/proj", { op: "click", target: "@150,140" })
    ).rejects.toThrow(/captcha/i);

    // Nenhum clique foi disparado para o canal da página.
    expect(sent.filter((c) => c.op === "click")).toEqual([]);

    // E dentro do runtime real da página, clicar em iframe de desafio ou em coordenadas sobre ele também é recusado.
    const harness = await loadRuntime(`
      <div class="g-recaptcha">
        <iframe id="cap-frame" title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=123"></iframe>
      </div>
      <button id="ok-btn">Continuar</button>
    `);
    const frame = document.getElementById("cap-frame")!;
    frame.getBoundingClientRect = () => ({ left: 50, top: 60, right: 350, bottom: 140, width: 300, height: 80, x: 50, y: 60, toJSON: () => ({}) }) as DOMRect;
    document.elementFromPoint = (x, y) => (x >= 50 && x <= 350 && y >= 60 && y <= 140 ? frame : null);

    await expect(harness.run({ op: "click", target: "#cap-frame" })).rejects.toThrow(/captcha/i);
    await expect(harness.run({ op: "click", target: "@120,100" })).rejects.toThrow(/captcha/i);
  });
});

describe("captcha invisível não trava o agente", () => {
  it("recaptcha_v3_invisivel_nao_detecta", () => {
    const snap: DocumentSnapshot = {
      title: "Loja",
      text: "Produtos em promoção",
      iframes: [{ src: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&size=invisible", title: "reCAPTCHA" }],
    };
    expect(detectCaptcha(snap)).toBeNull();
  });

  it("quadro_de_desafio_escondido_nao_detecta_e_visivel_detecta", () => {
    const hidden: DocumentSnapshot = {
      title: "Entrar",
      iframes: [{ src: "https://www.google.com/recaptcha/api2/bframe?k=abc", title: "recaptcha challenge", visible: false }],
    };
    expect(detectCaptcha(hidden)).toBeNull();
    expect(detectCaptcha({ ...hidden, iframes: [{ ...hidden.iframes![0]!, visible: undefined }] })).toBe("recaptcha");
  });

  it("widget_g_recaptcha_invisivel_no_dom_nao_detecta", () => {
    document.body.innerHTML = `<form><div class="g-recaptcha" data-size="invisible" data-sitekey="abc"></div><button>Enviar</button></form>`;
    expect(detectCaptcha(snapshotFromDocument(document))).toBeNull();
  });

  it("iframe_escondido_por_estilo_fica_invisivel_no_retrato", () => {
    document.body.innerHTML = `<div style="visibility:hidden"><iframe title="recaptcha challenge" src="https://www.google.com/recaptcha/api2/bframe?k=abc"></iframe></div>`;
    const snap = snapshotFromDocument(document);
    expect(snap.iframes![0]!.visible).toBe(false);
    expect(detectCaptcha(snap)).toBeNull();
  });
});
