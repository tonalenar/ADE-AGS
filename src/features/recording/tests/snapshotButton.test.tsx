// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_PENDING_CAPTURES, pendingCapturePaths, rememberPendingCapture } from "@/features/chat/attachments/pendingCaptures";
import { attachToComposer } from "@/features/chat/store";
import { AlertaToast } from "@/shared/ui/alerts";

import { DesktopSnapshotButton } from "../DesktopSnapshotButton";
import { desktopScreenshot } from "../ipc";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/chat/store", () => ({ attachToComposer: vi.fn() }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("../ipc", () => ({ desktopScreenshot: vi.fn() }));

const SHOT = "/Users/tonalencar/Pictures/ADE AGS/ADE-AGS_SnapShot_teste.png";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("navigator", { userAgent: MAC_UA });
  localStorage.clear();
  vi.mocked(attachToComposer).mockReset();
  vi.mocked(AlertaToast).mockReset();
  vi.mocked(desktopScreenshot).mockReset().mockResolvedValue(SHOT);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function render(target: string | null): Promise<HTMLButtonElement | null> {
  await act(async () => { root.render(<DesktopSnapshotButton target={target} />); });
  return host.querySelector("button");
}

/** Clica e deixa a promessa da captura terminar, sem relógio real. */
async function capture(button: HTMLButtonElement) {
  await act(async () => { button.click(); });
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("botão de SnapShot do composer", () => {
  it("não aparece fora do macOS", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    expect(await render("thread:1")).toBeNull();
  });

  it("guarda a captura antes de anexá-la, para ela sobreviver a trocar de conversa", async () => {
    const button = (await render("thread:1"))!;
    const seenWhenAttached: string[][] = [];
    vi.mocked(attachToComposer).mockImplementation(() => { seenWhenAttached.push(pendingCapturePaths("thread:1")); });
    await capture(button);
    expect(attachToComposer).toHaveBeenCalledWith([SHOT], "thread:1");
    expect(seenWhenAttached).toEqual([[SHOT]]);
  });

  it("sem conversa-alvo anexa como antes e não guarda nada", async () => {
    const button = (await render(null))!;
    await capture(button);
    expect(attachToComposer).toHaveBeenCalledWith([SHOT], null);
    expect(pendingCapturePaths(null)).toEqual([]);
  });

  it("ao passar do limite de pendentes, avisa que a mais antiga saiu da lista", async () => {
    for (let i = 0; i < MAX_PENDING_CAPTURES; i++) {
      rememberPendingCapture({ path: `/antiga${i}.png`, target: "thread:1", kind: "snapshot" }, i);
    }
    const button = (await render("thread:1"))!;
    await capture(button);
    const texts = vi.mocked(AlertaToast).mock.calls.map(([, text]) => text);
    expect(texts).toContain("screenRecording.pendingDropped");
    expect(pendingCapturePaths("thread:1")).toHaveLength(MAX_PENDING_CAPTURES);
    expect(pendingCapturePaths("thread:1")).toContain(SHOT);
  });
});
