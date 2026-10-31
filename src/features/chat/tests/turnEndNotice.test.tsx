// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o?.reason ? `${key}:${o.reason}` : key), i18n: { language: "pt-BR" } }),
}));

import { TurnEndNotice } from "@/features/chat/timeline/TurnEndNotice";

let root: Root | null = null;
let host: HTMLDivElement;

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
});

describe("TurnEndNotice", () => {
  it("um turno com erro mostra o motivo num alerta, com o estilo de erro", async () => {
    await render(<TurnEndNotice end={{ durationMs: 1000, interrupted: false, error: "O processo do Claude fechou", files: [] }} />);
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("chat.timeline.stopped:O processo do Claude fechou");
    expect(alert!.className).toContain("text-red-");
  });

  it("interrompido pela pessoa não é erro: sem alerta (o cabeçalho do turno já diz)", async () => {
    await render(<TurnEndNotice end={{ durationMs: null, interrupted: true, error: null, files: [] }} />);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("caiu e veio marcado como interrompido: o erro vence, a pessoa não parou nada", async () => {
    await render(<TurnEndNotice end={{ durationMs: null, interrupted: true, error: "O processo do Codex fechou no meio do turno", files: [] }} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("O processo do Codex fechou");
  });

  it("turno concluído não desenha aviso nenhum", async () => {
    await render(<TurnEndNotice end={{ durationMs: 5000, interrupted: false, error: null, files: [] }} />);
    expect(host.textContent).toBe("");
  });
});
