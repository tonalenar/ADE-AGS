// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => {
      if (o?.reason) return `${key}:${o.reason}`;
      return key;
    },
    i18n: { language: "pt-BR" },
  }),
}));

import { ToolRow } from "@/features/chat/timeline/ConversationTimeline";
import { NoticeRow } from "@/features/chat/timeline/NoticeRow";
import { TurnEndNotice } from "@/features/chat/timeline/TurnEndNotice";
import type { TimelineItem } from "@/features/chat/timeline/types";

let root: Root | null = null;
let host: HTMLDivElement;

async function render(node: React.ReactNode) {
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host.remove();
});

describe("Fase 5 - Desfecho desconhecido em ferramentas", () => {
  const unknownTool: TimelineItem = {
    kind: "tool",
    id: "tool-unknown-1",
    tool: "command",
    label: "git push origin main",
    status: "error",
    output: "TOOL_OUTCOME_UNKNOWN: a conversa parou antes do resultado; a ferramenta pode ter rodado.",
  };

  it("renderiza o estado próprio 'desfecho desconhecido' e não um erro comum", async () => {
    await render(<ToolRow tool={unknownTool} />);

    // Deve exibir o estado próprio "chat.tool.outcomeUnknown"
    expect(host.textContent).toContain("chat.tool.outcomeUnknown");
    // Não deve exibir como erro comum "chat.tool.failed"
    expect(host.textContent).not.toContain("chat.tool.failed");

    // O status ou o elemento deve ser acessível por leitor de tela
    const statusEl = host.querySelector('[role="status"]') || host.querySelector('[aria-label="chat.tool.outcomeUnknown"]');
    expect(statusEl).not.toBeNull();
  });

  it("explica que a ferramenta pode ter rodado ou não e sugere conferir o estado antes de repetir", async () => {
    await render(<ToolRow tool={unknownTool} />);

    // Se estiver fechado, clica para abrir (ou já vem visível)
    const button = host.querySelector("button");
    if (!host.textContent?.includes("chat.tool.outcomeUnknownHelp")) {
      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    expect(host.textContent).toContain("chat.tool.outcomeUnknownHelp");
  });

  it("não possui nenhum botão de repetir ou reenviar automático", async () => {
    await render(<ToolRow tool={unknownTool} />);

    const buttons = Array.from(host.querySelectorAll("button"));
    // Deve haver apenas o botão de abrir/fechar o ToolRow, nenhum botão de retry / repetir
    const retryButtons = buttons.filter((btn) => {
      const text = (btn.textContent || "").toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      return text.includes("repetir") || text.includes("retry") || text.includes("reenviar") || aria.includes("retry");
    });
    expect(retryButtons).toHaveLength(0);
  });
});

describe("Fase 5 - Aviso resumeLost na timeline", () => {
  it("renderiza aviso discreto com a razão quando ela vem no item", async () => {
    const item: TimelineItem = {
      kind: "notice",
      id: "n-resume-1",
      label: "resumeLost",
      text: "A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele. Motivo: thread not found",
    };
    await render(<NoticeRow item={item} />);

    const noticeEl = host.querySelector('[role="status"]');
    expect(noticeEl).not.toBeNull();
    expect(noticeEl!.textContent).toContain("chat.timeline.notice.resumeLost");
    expect(noticeEl!.textContent).toContain("thread not found");
  });
});

describe("Fase 5 - Turno interrompido na timeline", () => {
  it("aparece como aviso discreto na timeline com a razão quando vier no item", async () => {
    await render(
      <TurnEndNotice
        end={{
          durationMs: null,
          interrupted: true,
          error: null,
          reason: "Cancelado pelo usuário antes de concluir",
          files: [],
        }}
      />,
    );

    // Não deve ser um alerta de erro
    expect(host.querySelector('[role="alert"]')).toBeNull();

    // Deve ser um aviso discreto com role="status"
    const noticeEl = host.querySelector('[role="status"]');
    expect(noticeEl).not.toBeNull();
    expect(noticeEl!.textContent).toContain("chat.timeline.interruptedByYou");
    expect(noticeEl!.textContent).toContain("Cancelado pelo usuário antes de concluir");
  });

  it("aviso notice de interrupção na timeline aparece de forma discreta com a razão", async () => {
    await render(
      <NoticeRow
        item={{
          kind: "notice",
          id: "n-int-1",
          label: "interrupted",
          text: "Operação interrompida a pedido do usuário",
        }}
      />,
    );

    expect(host.querySelector('[role="alert"]')).toBeNull();
    const noticeEl = host.querySelector('[role="status"]');
    expect(noticeEl).not.toBeNull();
    expect(noticeEl!.textContent).toContain("chat.timeline.notice.interrupted");
    expect(noticeEl!.textContent).toContain("Operação interrompida a pedido do usuário");
  });
});
