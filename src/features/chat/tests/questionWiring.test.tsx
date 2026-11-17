// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { invokeMock, useInvokeMock } from "@/test/invokeMock";
import { questionOf } from "../structured/model";
import { answerRequest, useStructured } from "../structured/store";
import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";
import type { RequestRow } from "../structured/ipc";

useInvokeMock();

const OPTIONS = ["Autorizo", "Eu faço"];
const request: RequestRow = {
  id: "q1", threadId: "th", kind: "question", itemId: null, title: "", detail: "",
  options: [{ id: "opt", question: "Autoriza?", options: OPTIONS }],
  state: "pending", createdAt: 1,
};
const ask: TimelineItem = {
  kind: "tool", id: "q1", tool: "question", status: "running", label: "pergunta",
  question: { text: "Autoriza?", options: OPTIONS },
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useStructured.setState({ live: { th: { requests: [request] } } } as never);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const option = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe("a conversa por protocolo liga a resposta ao cartão da pergunta", () => {
  it("com pergunta esperando, o clique responde o pedido aberto; sem onAnswer as opções não enviam", async () => {
    invokeMock.on("chat_request_answer", true);
    const question = questionOf(request);
    expect(question).not.toBeNull();
    const answer = (choice: string) => { if (request) answerRequest("th", request.id, choice); };
    await act(async () => {
      root.render(
        <TimelineView items={[{ kind: "user", id: "u", text: "monte" }, ask]} loaded working approval={null} agentLabel="Claude Code" agentId="claude-code" onAnswer={question ? answer : undefined} />,
      );
    });
    await act(async () => { option(OPTIONS[0]!)!.click(); });
    expect(invokeMock.calls("chat_request_answer")).toEqual([{ requestId: "q1", choice: OPTIONS[0] }]);

    await act(async () => {
      root.render(
        <TimelineView items={[{ kind: "user", id: "u", text: "monte" }, ask]} loaded working approval={null} agentLabel="Claude Code" agentId="claude-code" />,
      );
    });
    expect(option(OPTIONS[0]!)).toBeUndefined();
  });
});
