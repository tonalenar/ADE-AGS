// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlertaToast } from "@/shared/ui/alerts";
import { VoiceInputButton } from "../VoiceInputButton";
import { voiceInputCancel, voiceInputStart, voiceInputStop } from "../ipc";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.locale) return `${key}:${options.locale}`;
      if (options?.error) return `${key}:${options.error}`;
      return key;
    },
    i18n: { language: "pt-BR", resolvedLanguage: "pt-BR" },
  }),
}));

vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("../ipc", () => ({
  voiceInputStart: vi.fn(),
  voiceInputStop: vi.fn(),
  voiceInputCancel: vi.fn(),
}));

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64)";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("navigator", { userAgent: MAC_UA });
  vi.mocked(AlertaToast).mockReset();
  vi.mocked(voiceInputStart).mockReset().mockResolvedValue("req-1");
  vi.mocked(voiceInputStop).mockReset().mockResolvedValue("Texto transcrito para revisão");
  vi.mocked(voiceInputCancel).mockReset().mockResolvedValue();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function renderButton(props: {
  onTranscript?: (text: string) => void;
  disabled?: boolean;
  isComposerActive?: () => boolean;
} = {}) {
  const onTranscript = props.onTranscript ?? vi.fn();
  const isComposerActive = props.isComposerActive ?? (() => true);
  await act(async () => {
    root.render(
      <VoiceInputButton
        onTranscript={onTranscript}
        disabled={props.disabled}
        isComposerActive={isComposerActive}
      />,
    );
  });
  return {
    button: host.querySelector("button"),
    status: host.querySelector("[role='status']"),
    onTranscript,
  };
}

describe("VoiceInputButton - paridade de plataformas e acessibilidade", () => {
  it("no Windows aparece desabilitado com a razão e avisa ao receber atalho", async () => {
    vi.stubGlobal("navigator", { userAgent: WIN_UA });
    const { button } = await renderButton();
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("title")).toBe("voiceInput.unavailable.windows");
    expect(button?.getAttribute("aria-label")).toContain("voiceInput.unavailable.windows");

    // O atalho não falha em silêncio: exibe a razão
    await act(async () => {
      window.dispatchEvent(new Event("ade:voice-input-toggle"));
    });
    expect(AlertaToast).toHaveBeenCalledWith("voiceInput.title", "voiceInput.unavailable.windows", "info", 5000);
  });

  it("no Linux aparece desabilitado com a razão e avisa ao receber atalho", async () => {
    vi.stubGlobal("navigator", { userAgent: LINUX_UA });
    const { button } = await renderButton();
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("title")).toBe("voiceInput.unavailable.linux");
    expect(button?.getAttribute("aria-label")).toContain("voiceInput.unavailable.linux");

    await act(async () => {
      window.dispatchEvent(new Event("ade:voice-input-toggle"));
    });
    expect(AlertaToast).toHaveBeenCalledWith("voiceInput.title", "voiceInput.unavailable.linux", "info", 5000);
  });

  it("no macOS possui estados acessíveis com aria-pressed e anúncio por role=status", async () => {
    const { button } = await renderButton();
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    const status = host.querySelector("[role='status']");
    expect(status).not.toBeNull();

    // Inicia o ditado
    await act(async () => {
      button?.click();
    });
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(status?.textContent).toBe("voiceInput.status.recording");

    // Finaliza o ditado
    await act(async () => {
      button?.click();
    });
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(status?.textContent).toBe("voiceInput.status.stopped");
  });

  it("a transcrição sempre entra no callback onTranscript e nunca é enviada sozinha", async () => {
    const onTranscript = vi.fn();
    const { button } = await renderButton({ onTranscript });

    // Inicia gravação
    await act(async () => {
      button?.click();
    });
    expect(voiceInputStart).toHaveBeenCalled();

    // Para gravação
    await act(async () => {
      button?.click();
    });
    expect(voiceInputStop).toHaveBeenCalled();
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("Texto transcrito para revisão");
  });

  it("anuncia descarte via role=status ao cancelar", async () => {
    const { button } = await renderButton();
    const status = host.querySelector("[role='status']");

    await act(async () => {
      button?.click();
    });
    expect(status?.textContent).toBe("voiceInput.status.recording");

    // Botão de cancelar (segundo botão renderizado durante gravação)
    const cancelButton = host.querySelectorAll("button")[1];
    expect(cancelButton).toBeDefined();
    await act(async () => {
      cancelButton.click();
    });
    expect(voiceInputCancel).toHaveBeenCalled();
    expect(status?.textContent).toBe("voiceInput.status.cancelled");
  });

  it("anuncia erro via role=status quando a inicialização falha", async () => {
    vi.mocked(voiceInputStart).mockRejectedValueOnce(new Error("Microfone desconectado"));
    const { button } = await renderButton();
    const status = host.querySelector("[role='status']");

    await act(async () => {
      button?.click();
    });
    expect(status?.textContent).toContain("voiceInput.status.error");
    expect(AlertaToast).toHaveBeenCalledWith("voiceInput.title", "Error: Microfone desconectado", "error", 6000);
  });
});
