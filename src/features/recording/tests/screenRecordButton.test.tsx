// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBotToastStore } from "@/shared/brand/botToastStore";
import { AlertaToast } from "@/shared/ui/alerts";
import { ScreenRecordButton } from "../ScreenRecordButton";
import { openPrivacySettings, screenRecordingStart, screenRecordingStatus, screenRecordingStop } from "../ipc";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("@/features/chat/store", () => ({ attachToComposer: vi.fn() }));
vi.mock("../ipc", () => ({
  openPrivacySettings: vi.fn(),
  screenRecordingStart: vi.fn(),
  screenRecordingStatus: vi.fn(),
  screenRecordingStop: vi.fn(),
}));

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)";
const PERMISSAO = "SCREEN_CAPTURE_PERMISSION_REQUIRED: O macOS não autorizou a Gravação de Tela.";
const ESPELHO = "IPHONE_MIRROR_REQUIRED: O iPhone não aceita gravação de tela pelo devicectl. Ligue o espelho do aparelho na ADE para gravar.";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("navigator", { userAgent: MAC_UA });
  vi.mocked(AlertaToast).mockReset();
  useBotToastStore.setState({ toasts: [] });
  vi.mocked(openPrivacySettings).mockReset().mockResolvedValue();
  vi.mocked(screenRecordingStatus).mockReset().mockResolvedValue(null);
  vi.mocked(screenRecordingStart).mockReset().mockResolvedValue("desktop:main");
  vi.mocked(screenRecordingStop).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function renderButton(kind: "desktop" | "simulator" | "iphone" = "desktop") {
  await act(async () => {
    root.render(<ScreenRecordButton kind={kind} target="main" label="Tela" composerTarget="aba-1" />);
  });
  return host.querySelector("button") as HTMLButtonElement;
}

describe("ScreenRecordButton: erros de gravação", () => {
  it("sem permissão de Gravação de Tela, oferece abrir o painel em vez de despejar o código do erro", async () => {
    vi.mocked(screenRecordingStart).mockRejectedValueOnce(PERMISSAO);
    const button = await renderButton();

    await act(async () => { button.click(); });

    const toast = useBotToastStore.getState().toasts[0];
    expect(toast.text).toBe("screenRecording.permissionRequired");
    expect(toast.actionLabel).toBe("screenRecording.openSettings");
    expect(AlertaToast).not.toHaveBeenCalledWith("screenRecording.title", expect.stringContaining("SCREEN_CAPTURE"), "error", expect.anything());
    await act(async () => { toast.onAction?.(); await Promise.resolve(); });
    expect(openPrivacySettings).toHaveBeenCalledWith("screen_capture");
  });

  it("iPhone sem capacidade de gravar pelo devicectl: diz para ligar o espelho, traduzido, sem o marcador nem o texto cru", async () => {
    vi.mocked(screenRecordingStart).mockRejectedValueOnce(ESPELHO);
    const button = await renderButton("iphone");

    await act(async () => { button.click(); });

    expect(AlertaToast).toHaveBeenCalledWith("screenRecording.title", "screenRecording.iphoneNeedsMirror", "error", 6000);
    expect(AlertaToast).not.toHaveBeenCalledWith("screenRecording.title", expect.stringContaining("IPHONE_MIRROR"), "error", expect.anything());
    expect(useBotToastStore.getState().toasts).toHaveLength(0);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("ao parar, o motivo real da ferramenta aparece no aviso e o botão sai do estado gravando", async () => {
    vi.mocked(screenRecordingStatus).mockResolvedValueOnce("simulator:main");
    vi.mocked(screenRecordingStop).mockRejectedValueOnce("O simulador iOS não está ligado.");
    const button = await renderButton("simulator");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await act(async () => { button.click(); });

    expect(AlertaToast).toHaveBeenCalledWith("screenRecording.title", "O simulador iOS não está ligado.", "error", 5000);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("a permissão negada ao parar também leva ao painel de ajustes", async () => {
    vi.mocked(screenRecordingStatus).mockResolvedValueOnce("desktop:main");
    vi.mocked(screenRecordingStop).mockRejectedValueOnce(PERMISSAO);
    const button = await renderButton();

    await act(async () => { button.click(); });

    expect(useBotToastStore.getState().toasts[0].text).toBe("screenRecording.permissionRequired");
  });
});
