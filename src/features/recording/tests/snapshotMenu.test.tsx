// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachToComposer } from "@/features/chat/store";
import { AlertaToast } from "@/shared/ui/alerts";

import { DesktopSnapshotButton } from "../DesktopSnapshotButton";
import { desktopScreenshot, desktopSnapshotTargets } from "../ipc";
import { SNAPSHOT_DEFAULT_EVENT, type SnapshotListing } from "../snapshotTargets";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key) }),
}));
vi.mock("@/features/chat/store", () => ({ attachToComposer: vi.fn() }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("../ipc", () => ({ desktopScreenshot: vi.fn(), desktopSnapshotTargets: vi.fn() }));

const SHOT = "/Users/pessoa/Pictures/ADE AGS/ADE-AGS_SnapShot_teste.png";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)";
const LAST_CHOICE_KEY = "cc-snapshot-ultima-escolha";
const MAIN = "screenRecording.targetMain";

const LISTA: SnapshotListing = {
  titles: true,
  displays: [
    { id: 7, main: false, number: 2, pixelWidth: 2560, pixelHeight: 1440, pointsWidth: 2560, pointsHeight: 1440, capturable: true, blocked: null },
    { id: 1, main: true, number: 1, pixelWidth: 3024, pixelHeight: 1964, pointsWidth: 1512, pointsHeight: 982, capturable: true, blocked: null },
  ],
  windows: [
    { id: 101, app: "Safari", title: "Página de teste", capturable: true },
    { id: 102, app: "Terminal", title: null, capturable: true },
  ],
};

const SEM_PERMISSAO: SnapshotListing = {
  titles: false,
  displays: [
    { id: 1, main: true, number: 1, pixelWidth: 3024, pixelHeight: 1964, pointsWidth: 1512, pointsHeight: 982, capturable: true, blocked: null },
    { id: 7, main: false, number: 2, pixelWidth: 2560, pixelHeight: 1440, pointsWidth: 2560, pointsHeight: 1440, capturable: false, blocked: "permission" },
  ],
  windows: [{ id: 101, app: "Safari", title: null, capturable: false }],
};

/** A lista de agora, sem o Safari que a pessoa tinha escolhido antes. */
const SEM_SAFARI: SnapshotListing = { ...LISTA, windows: [{ id: 102, app: "Terminal", title: null, capturable: true }] };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("navigator", { userAgent: MAC_UA });
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(attachToComposer).mockReset();
  vi.mocked(AlertaToast).mockReset();
  vi.mocked(desktopScreenshot).mockReset().mockResolvedValue(SHOT);
  vi.mocked(desktopSnapshotTargets).mockReset().mockResolvedValue(LISTA);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
/** Uma tecla no elemento que tem o foco agora, como o teclado faz de verdade. */
const press = (k: string) => act(async () => {
  (document.activeElement ?? host).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
});

async function render(target: string | null = "thread:1") {
  await act(async () => { root.render(<DesktopSnapshotButton target={target} />); });
}
const camera = () => host.querySelector<HTMLButtonElement>("[data-chat-desktop-snapshot]")!;
const menu = () => host.querySelector<HTMLElement>("[role=menu]");
const items = () => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
const itemWith = (text: string) => items().find((el) => el.textContent?.includes(text))!;

/** Abre o menu como a pessoa faz: um clique na câmera e a lista chega. */
async function openMenu() {
  await click(camera());
  await flush();
}

describe("câmera do composer com menu de tela ou janela, no lugar da pílula", () => {
  it("não aparece fora do macOS", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    await render();
    expect(host.querySelector("[data-chat-desktop-snapshot]")).toBeNull();
  });

  it("a pílula de alvo sumiu: ao lado do clipe fica só a câmera", async () => {
    await render();
    expect(host.querySelector("button[aria-haspopup=listbox]")).toBeNull();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).not.toContain(MAIN);
    expect(camera().getAttribute("aria-haspopup")).toBe("menu");
    expect(camera().getAttribute("aria-expanded")).toBe("false");
  });

  it("clicar na câmera abre o menu com a tela principal primeiro, e não captura", async () => {
    await render();
    await openMenu();
    expect(menu()).not.toBeNull();
    expect(camera().getAttribute("aria-expanded")).toBe("true");
    expect(items()[0].textContent).toContain(MAIN);
    expect(desktopScreenshot).not.toHaveBeenCalled();
  });

  it("a lista de telas e janelas é lida ao abrir o menu, não ao montar o composer", async () => {
    await render();
    expect(desktopSnapshotTargets).not.toHaveBeenCalled();
    await openMenu();
    expect(desktopSnapshotTargets).toHaveBeenCalledTimes(1);
  });

  it("outra tela aparece no grupo de telas e, quando escolhida, captura esse display", async () => {
    await render();
    await openMenu();
    expect(host.textContent).toContain("screenRecording.groupDisplays");
    await click(itemWith('"number":2'));
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "display", id: 7 });
  });

  it("escolher uma janela captura só essa janela, anexa ao rascunho e fecha o menu", async () => {
    await render();
    await openMenu();
    await click(itemWith("Safari"));
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "window", id: 101 });
    expect(attachToComposer).toHaveBeenCalledWith([SHOT], "thread:1");
    expect(menu()).toBeNull();
  });

  it("escolher a tela principal captura a principal, mesmo com janelas na lista", async () => {
    await render();
    await openMenu();
    await click(items()[0]);
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "main" });
  });

  it("o atalho pede a tela principal direto e não abre o menu; com o menu aberto, fecha-o", async () => {
    await render();
    await act(async () => { camera().dispatchEvent(new CustomEvent(SNAPSHOT_DEFAULT_EVENT)); });
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "main" });
    expect(menu()).toBeNull();
    await openMenu();
    await act(async () => { camera().dispatchEvent(new CustomEvent(SNAPSHOT_DEFAULT_EVENT)); });
    await flush();
    expect(menu()).toBeNull();
    expect(desktopScreenshot).toHaveBeenCalledTimes(2);
  });
});

describe("teclado no menu", () => {
  it("ao abrir, o foco vai para a tela principal", async () => {
    await render();
    await openMenu();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("setas andam pelos itens na ordem do menu, e Enter captura o item em foco", async () => {
    await render();
    await openMenu();
    await press("ArrowDown");
    expect(document.activeElement).toBe(itemWith('"number":2'));
    await press("ArrowDown");
    expect(document.activeElement).toBe(itemWith("Safari"));
    await press("Enter");
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "window", id: 101 });
    expect(menu()).toBeNull();
  });

  it("seta para cima na tela principal dá a volta à última janela; Home e End vão às pontas", async () => {
    await render();
    await openMenu();
    await press("ArrowUp");
    expect(document.activeElement).toBe(itemWith("Terminal"));
    await press("Home");
    expect(document.activeElement).toBe(items()[0]);
    await press("End");
    expect(document.activeElement).toBe(itemWith("Terminal"));
    expect(desktopScreenshot).not.toHaveBeenCalled();
  });

  it("Esc fecha o menu sem capturar e devolve o foco à câmera", async () => {
    await render();
    await openMenu();
    await press("Escape");
    expect(menu()).toBeNull();
    expect(desktopScreenshot).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(camera());
  });

  it("Tab fecha o menu sem capturar", async () => {
    await render();
    await openMenu();
    await press("Tab");
    expect(menu()).toBeNull();
    expect(desktopScreenshot).not.toHaveBeenCalled();
  });
});

describe("permissão, falha e lembrança da escolha", () => {
  it("sem Gravação de Tela, as janelas e a outra tela aparecem bloqueadas, com o aviso; setas pulam os bloqueados", async () => {
    vi.mocked(desktopSnapshotTargets).mockResolvedValue(SEM_PERMISSAO);
    await render();
    await openMenu();
    expect(itemWith("Safari").disabled).toBe(true);
    expect(host.textContent).toContain("screenRecording.groupWindowsNoPermission");
    expect(host.textContent).toContain("screenRecording.blockedPermission");
    await click(itemWith("Safari"));
    expect(desktopScreenshot).not.toHaveBeenCalled();
    await press("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("se a leitura da lista falha, a tela principal segue capturando e o menu diz o que aconteceu", async () => {
    vi.mocked(desktopSnapshotTargets).mockRejectedValue(new Error("helper indisponível"));
    await render();
    await openMenu();
    expect(host.textContent).toContain("screenRecording.listFailed");
    await click(items()[0]);
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "main" });
  });

  it("a última escolha vira o item em foco na próxima abertura, e Enter a captura de novo", async () => {
    await render();
    await openMenu();
    await click(itemWith("Safari"));
    await flush();
    await openMenu();
    expect(document.activeElement).toBe(itemWith("Safari"));
    await press("Enter");
    await flush();
    expect(desktopScreenshot).toHaveBeenNthCalledWith(2, { kind: "window", id: 101 });
  });

  it("se a janela lembrada sumiu da lista, o foco volta à tela principal", async () => {
    await render();
    await openMenu();
    await click(itemWith("Safari"));
    await flush();
    vi.mocked(desktopSnapshotTargets).mockResolvedValue(SEM_SAFARI);
    await openMenu();
    expect(document.activeElement).toBe(items()[0]);
    expect(items().some((el) => el.textContent?.includes("Safari"))).toBe(false);
  });

  it("com a lista ainda chegando, o foco fica na tela principal e vai à última escolha quando ela chega", async () => {
    sessionStorage.setItem(LAST_CHOICE_KEY, "window:101");
    let arrive!: (next: SnapshotListing) => void;
    vi.mocked(desktopSnapshotTargets).mockReturnValueOnce(new Promise<SnapshotListing>((resolve) => { arrive = resolve; }));
    await render();
    await openMenu();
    expect(document.activeElement).toBe(items()[0]);
    await act(async () => { arrive(LISTA); });
    await flush();
    expect(document.activeElement).toBe(itemWith("Safari"));
  });
});
