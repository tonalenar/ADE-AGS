// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("indicador único de atividade da conversa", () => {
  it("enquanto o turno está aberto, a timeline mostra a linha de trabalho e não a ActivityLine do composer", async () => {
    const items: TimelineItem[] = [{ kind: "user", id: "u1", text: "explique" }];
    await act(async () => {
      root.render(
        <TimelineView items={items} loaded working live streaming={undefined} approval={null} agentLabel="Claude" agentId="claude-code" />,
      );
    });
    expect(host.querySelector("[data-working-row]")).not.toBeNull();
    expect(host.querySelector("button[aria-expanded]")).toBeNull();
  });
});
