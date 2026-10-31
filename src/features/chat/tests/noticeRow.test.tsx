// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import { NoticeRow } from "@/features/chat/timeline/NoticeRow";
import type { TimelineItem } from "@/features/chat/timeline/types";

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

const notice = (label: string, text: string): TimelineItem => ({ kind: "notice", id: `n-${label}`, label, text });

describe("NoticeRow", () => {
  it("a sessão que não voltou mostra a frase do código e o motivo", async () => {
    await render(<NoticeRow item={notice("resumeLost", "A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele. Motivo: thread not found")} />);
    const text = host.querySelector('[role="status"]')!.textContent!;
    expect(text).toContain("chat.timeline.notice.resumeLost");
    expect(text).toContain("thread not found");
  });

  it("a mensagem descartada da fila aparece com o texto e o botão de reenviar", async () => {
    const onResend = vi.fn();
    await render(<NoticeRow item={notice("queueDropped", "e o lint?")} onResend={onResend} />);
    expect(host.textContent).toContain("chat.timeline.notice.queueDropped");
    expect(host.textContent).toContain("e o lint?");
    await act(async () => { host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onResend).toHaveBeenCalledWith("e o lint?");
  });

  it("sem a função de reenviar não há botão; código desconhecido mostra o texto do app", async () => {
    await render(<NoticeRow item={notice("queueDropped", "x")} />);
    expect(host.querySelector("button")).toBeNull();
    await render(<NoticeRow item={notice("algoNovo", "aviso novo")} />);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("aviso novo");
  });
});
