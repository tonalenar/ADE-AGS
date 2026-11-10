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

const LISTA: SnapshotListing = {
  titles: true,
  displays: [
    { id: 1, main: true, number: 1, pixelWidth: 3024, pixelHeight: 1964, pointsWidth: 1512, pointsHeight: 982, capturable: true, blocked: null },
    { id: 7, main: false, number: 2, pixelWidth: 2560, pixelHeight: 1440, pointsWidth: 2560, pointsHeight: 1440, capturable: true, blocked: null },
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

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("navigator", { userAgent: MAC_UA });
  localStorage.clear();
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
const key = (el: Element, k: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
});

async function render(target: string | null = "thread:1") {
  await act(async () => { root.render(<DesktopSnapshotButton target={target} />); });
}
const picker = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!;
const camera = () => host.querySelector<HTMLButtonElement>("[data-chat-desktop-snapshot]")!;
const optionWith = (text: string) => [...document.querySelectorAll<HTMLElement>("div[role=option]")].find((o) => o.textContent?.includes(text))!;

/** Abre o seletor como a pessoa faz: o ponteiro chega primeiro (carrega a lista) e depois o clique abre. */
async function openPicker() {
  await act(async () => { picker().dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  await flush();
  await click(picker());
}

describe("seletor de tela ou janela ao lado da câmera", () => {
  it("não aparece fora do macOS", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    await render();
    expect(host.querySelector("button[aria-haspopup=listbox]")).toBeNull();
    expect(camera()).toBeNull();
  });

  it("a tela principal é o padrão: a câmera captura a principal, como antes", async () => {
    await render();
    expect(picker().textContent).toContain("screenRecording.targetMain");
    await click(camera());
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "main" });
    expect(attachToComposer).toHaveBeenCalledWith([SHOT], "thread:1");
  });

  it("escolher uma janela faz a câmera capturar só essa janela e o seletor volta ao padrão", async () => {
    await render();
    await openPicker();
    await click(optionWith("Safari"));
    expect(picker().textContent).toContain("Safari — Página de teste");
    await click(camera());
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "window", id: 101 });
    expect(picker().textContent).toContain("screenRecording.targetMain");
  });

  it("dá para escolher a outra tela só com o teclado", async () => {
    await render();
    await act(async () => { picker().dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await flush();
    await key(picker(), "ArrowDown");
    await key(picker(), "ArrowDown");
    await key(picker(), "Enter");
    await click(camera());
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "display", id: 7 });
  });

  it("sem permissão de Gravação de Tela, janelas e a outra tela aparecem bloqueadas, com o motivo no grupo", async () => {
    vi.mocked(desktopSnapshotTargets).mockResolvedValue(SEM_PERMISSAO);
    await render();
    await openPicker();
    const janela = optionWith("Safari");
    expect(janela.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("screenRecording.groupWindowsNoPermission");
    await click(janela);
    expect(picker().textContent).toContain("screenRecording.targetMain");
  });

  it("o ponteiro sobre uma opção do menu não relê a lista: só o gesto que começa no seletor lê", async () => {
    await render();
    await openPicker();
    expect(desktopSnapshotTargets).toHaveBeenCalledTimes(1);
    await act(async () => { optionWith("Safari").dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await flush();
    expect(desktopSnapshotTargets).toHaveBeenCalledTimes(1);
  });

  it("o atalho pede a tela principal mesmo com uma janela escolhida no seletor", async () => {
    await render();
    await openPicker();
    await click(optionWith("Safari"));
    await act(async () => { camera().dispatchEvent(new CustomEvent(SNAPSHOT_DEFAULT_EVENT)); });
    await flush();
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "main" });
  });

  it("se a listagem falha, a câmera segue na tela principal e o seletor diz o que aconteceu", async () => {
    vi.mocked(desktopSnapshotTargets).mockRejectedValue(new Error("helper indisponível"));
    await render();
    await openPicker();
    expect(document.body.textContent).toContain("screenRecording.listFailed");
    await click(camera());
    expect(desktopScreenshot).toHaveBeenCalledWith({ kind: "main" });
  });
});
