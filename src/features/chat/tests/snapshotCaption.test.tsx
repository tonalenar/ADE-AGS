// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("../attachments/ipc", () => ({
  inspectPaths: () => Promise.resolve([]),
  readImage: () => Promise.resolve({ mime: "image/png", dataUrl: "data:image/png;base64,AA" }),
}));
vi.mock("@/features/recording/ipc", () => ({ desktopSnapshotInfo: vi.fn() }));

import { desktopSnapshotInfo } from "@/features/recording/ipc";

import { AttachmentStrip } from "../attachments/AttachmentStrip";

const JANELA = "/Users/p/Imagens/ADE AGS/ADE-AGS_SnapShot_2026-11-10_17-00-00_janela.png";
const TELA = "/Users/p/Imagens/ADE AGS/ADE-AGS_SnapShot_2026-11-10_17-01-00_tela.png";
const SEM_JSON = "/Users/p/Imagens/ADE AGS/ADE-AGS_SnapShot_2026-11-10_17-02-00_sem.png";
const FOTO = "/Users/p/Desktop/foto.png";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(desktopSnapshotInfo).mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

describe("legenda da captura no anexo", () => {
  it("janela mostra app e título; tela principal mostra o nome da tela", async () => {
    vi.mocked(desktopSnapshotInfo).mockImplementation((paths) => Promise.resolve(paths.map((p) => (p === JANELA
      ? { version: 1, scope: "window" as const, app: "Safari", title: "Página de teste", displayNumber: null, capturedAt: "x" }
      : { version: 1, scope: "display" as const, app: null, title: null, displayNumber: 1, capturedAt: "x" }))));
    await act(async () => {
      root.render(<AttachmentStrip items={[
        { path: JANELA, name: "janela.png", kind: "image", size: 10 },
        { path: TELA, name: "tela.png", kind: "image", size: 10 },
      ]} />);
    });
    await flush();
    expect(host.textContent).toContain("Safari — Página de teste");
    expect(host.textContent).toContain("screenRecording.targetMain");
  });

  it("sem o JSON ao lado, a foto aparece sem legenda inventada", async () => {
    vi.mocked(desktopSnapshotInfo).mockResolvedValue([null]);
    await act(async () => {
      root.render(<AttachmentStrip items={[{ path: SEM_JSON, name: "sem.png", kind: "image", size: 10 }]} />);
    });
    await flush();
    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.textContent).not.toContain("screenRecording");
    expect(host.textContent).not.toContain("Safari");
  });

  it("foto que não é do SnapShot não consulta metadado nenhum", async () => {
    vi.mocked(desktopSnapshotInfo).mockResolvedValue([null]);
    await act(async () => {
      root.render(<AttachmentStrip items={[{ path: FOTO, name: "foto.png", kind: "image", size: 10 }]} />);
    });
    await flush();
    expect(desktopSnapshotInfo).not.toHaveBeenCalled();
  });
});
