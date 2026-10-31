import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

describe("rolagem sem barra visível no modo chat", () => {
  const css = read("../../../App.css");

  it("o utilitário esconde a barra nos dois motores e mantém a rolagem (overflow-y: auto)", () => {
    const block = /\.cc-scroll-hidden \{([^}]*)\}/.exec(css)![1]!;
    expect(block).toContain("overflow-y: auto");
    expect(block).toContain("scrollbar-width: none");
    expect(css).toMatch(/\.cc-scroll-hidden::-webkit-scrollbar \{[^}]*display: none/);
  });

  it("não sobra um carril reservado (scrollbar-gutter) no utilitário escondido", () => {
    expect(/\.cc-scroll-hidden \{([^}]*)\}/.exec(css)![1]).not.toContain("scrollbar-gutter");
  });

  const hidden = [
    "../timeline/ConversationTimeline.tsx", "../summary/SummaryPane.tsx", "../team/TeamPanel.tsx", "../team/DraftTeamPanel.tsx",
    "../ChatSidebar.tsx", "../AgentModelPicker.tsx", "../permissions/PermissionsInbox.tsx", "../NewConversation.tsx",
  ];
  for (const file of hidden) {
    it(`${file.split("/").pop()} usa o utilitário e não a barra visível`, () => {
      const source = read(file);
      expect(source).toContain("cc-scroll-hidden");
      expect(source).not.toMatch(/\bcc-scroll\b(?!-)/);
    });
  }

  it("editores e terminais mantêm as barras deles: o utilitário só entra em features/chat", () => {
    expect(read("../../terminal/Terminal.tsx")).not.toContain("cc-scroll-hidden");
    expect(read("../../explorer/FilesView.tsx")).not.toContain("cc-scroll-hidden");
  });
});
