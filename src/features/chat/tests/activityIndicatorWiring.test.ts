import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatSource = (path: string) => readFileSync(resolve(process.cwd(), "src/features/chat", path), "utf8");

describe("indicador único de atividade da conversa", () => {
  it("mantém o estado de trabalho na timeline, como no T3 Code", () => {
    expect(chatSource("timeline/ConversationTimeline.tsx")).toContain("data-working-row");
    expect(chatSource("ConversationView.tsx")).not.toContain("<ActivityLine");
    expect(chatSource("structured/StructuredConversationView.tsx")).not.toContain("<ActivityLine");
    expect(chatSource("ChatShell.tsx")).not.toContain("<ActiveLive");
  });
});
