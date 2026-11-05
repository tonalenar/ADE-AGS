import { describe, expect, it } from "vitest";

import { chatPlacements } from "@/features/tabs/layout/layoutStore";
import { codeOfPre } from "@/shared/ui/Markdown";

import { codeLang, findShellTab, runnableCommand } from "../codeRun";

describe("o «Rodar» dos blocos de código", () => {
  it("só bloco de shell roda; sem linguagem, ou de outra, não", () => {
    expect(runnableCommand("bash", "npx tsc --noEmit\n")).toBe("npx tsc --noEmit");
    expect(runnableCommand("zsh", "cd app\nbun test")).toBe("cd app\nbun test");
    expect(runnableCommand(null, "ls")).toBeNull();
    expect(runnableCommand("ts", "const a = 1")).toBeNull();
    expect(runnableCommand("bash", "\n\n")).toBeNull();
  });

  it("num bloco de sessão vão só as linhas de comando, sem o prompt nem a saída", () => {
    expect(runnableCommand("console", "$ git status\nOn branch dev\n$ git log -1")).toBe("git status\ngit log -1");
    expect(runnableCommand("console", "echo sem prompt")).toBe("echo sem prompt");
  });

  it("a linguagem sai da classe do markdown", () => {
    expect(codeLang("language-Bash")).toBe("bash");
    expect(codeLang("hljs language-sh")).toBe("sh");
    expect(codeLang(undefined)).toBeNull();
  });

  it("o terminal da conversa é a aba de shell da mesma pasta, nunca a de um agente", () => {
    const tabs = [
      { id: "a", agentId: "claude-code", cwd: "/repo" },
      { id: "b", agentId: "bash", cwd: "/outro" },
      { id: "c", agentId: "bash", cwd: "/repo" },
    ];
    expect(findShellTab(tabs, "/repo")).toBe("c");
    expect(findShellTab(tabs, "/nada")).toBeNull();
  });

  it("o texto e a linguagem do bloco saem da árvore do markdown", () => {
    const pre = { type: "element", tagName: "pre", children: [
      { type: "element", tagName: "code", properties: { className: ["language-bash"] }, children: [{ type: "text", value: "ls -la\n" }] },
    ] };
    expect(codeOfPre(pre)).toEqual({ code: "ls -la\n", className: "language-bash" });
  });
});

describe("o terminal da aba Terminal no modo chat", () => {
  const rect = { left: 10, top: 20, width: 300, height: 200 };

  it("aparece no slot dele e leva o teclado quando não há gaveta do agente", () => {
    const placed = chatPlacements(null, "conversa", null, { tabId: "sh", rect });
    expect(placed.visible.get("a:sh")?.rect).toEqual(rect);
    expect(placed.focusedItem).toBe("a:sh");
  });

  it("com a gaveta do agente aberta, os dois aparecem e o teclado fica no agente", () => {
    const placed = chatPlacements(rect, "conversa", null, { tabId: "sh", rect: { ...rect, left: 400 } });
    expect([...placed.visible.keys()].sort()).toEqual(["a:conversa", "a:sh"]);
    expect(placed.focusedItem).toBe("a:conversa");
  });
});
