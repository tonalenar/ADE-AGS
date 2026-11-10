import { describe, expect, it } from "vitest";

import { searchTimelineItems, searchTuiConversation } from "../timeline/search";
import type { TimelineItem } from "../timeline/types";

const item = (id: string, kind: TimelineItem["kind"], text: string): TimelineItem => ({ id, kind, text });

describe("busca local nos transcripts das conversas TUI", () => {
  const items = [
    item("old", "user", "Verificar o coração da integração"),
    item("tool", "tool", "coração integração"),
    item("answer", "assistant", "A integração está funcionando"),
    item("new", "user", "Outro pedido"),
  ];

  it("procura sem diferenciar acentos, exige todos os termos e devolve do mais recente para o antigo", () => {
    expect(searchTimelineItems(items, "integracao coracao").map((hit) => hit.id)).toEqual(["old"]);
    expect(searchTimelineItems(items, "integracao funcionando").map((hit) => hit.id)).toEqual(["answer"]);
    expect(searchTimelineItems(items, "coração integração", 0)).toEqual([]);
  });

  it("só inclui falas da pessoa e do agente e produz resultado navegável", () => {
    expect(searchTuiConversation(items, "integração", { tabId: "tab-1", title: "ADE", agentId: "codex", cwd: "/p/ade" }))
      .toEqual([
        { tabId: "tab-1", title: "ADE", agentId: "codex", cwd: "/p/ade", itemId: "answer", kind: "assistant", excerpt: "A integração está funcionando" },
        { tabId: "tab-1", title: "ADE", agentId: "codex", cwd: "/p/ade", itemId: "old", kind: "user", excerpt: "Verificar o coração da integração" },
      ]);
  });
});
