import { describe, expect, it } from "vitest";

import {
  AUTO_THROTTLE_MS, authorKey, autoCaptureFor, cleanTyped, closedTabs, describeBlockers, diffTone, kindKey, undoFor,
} from "../model";
import type { TabCheckpoint } from "../types";

const cp = (seq: number, kind: string): TabCheckpoint => ({
  id: `id${seq}`, tabId: "t", seq, kind, author: "pessoa", message: "", repoRoot: "/r",
  refName: `refs/ags/checkpoints/t/${seq}`, commitSha: "c", treeSha: "t", headSha: null, createdAt: seq,
});

describe("o que um Enter vira", () => {
  it("tira a borda da caixa e o sinal do prompt do texto digitado", () => {
    expect(cleanTyped("│ > corrige o login  │")).toBe("corrige o login");
    expect(cleanTyped("❯ ❯   faz o deploy")).toBe("faz o deploy");
    expect(cleanTyped("╭──╮")).toBe("");
  });

  it("o colado pelo app tem prioridade e é do app", () => {
    expect(autoCaptureFor({ pasted: "briefing da missão", typed: "[Pasted Content 3904 chars]", at: 10 }))
      .toEqual({ message: "briefing da missão", author: "ade" });
  });

  it("o que a pessoa digitou é dela", () => {
    expect(autoCaptureFor({ pasted: null, typed: "› adiciona testes", at: 10 })).toEqual({ message: "adiciona testes", author: "pessoa" });
  });

  it("Enter numa caixa vazia não vira ponto", () => {
    expect(autoCaptureFor({ pasted: null, typed: "│ >  │", at: 10 })).toBeNull();
  });

  it("dois Enters seguidos na mesma aba contam como um", () => {
    expect(autoCaptureFor({ pasted: null, typed: "oi de novo", lastAt: 1000, at: 1000 + AUTO_THROTTLE_MS - 1 })).toBeNull();
    expect(autoCaptureFor({ pasted: null, typed: "oi de novo", lastAt: 1000, at: 1000 + AUTO_THROTTLE_MS })).not.toBeNull();
  });
});

describe("rótulos e bloqueios", () => {
  it("quem mandou e o tipo viram chaves de i18n conhecidas", () => {
    expect(authorKey("pessoa")).toBe("tabCheckpoints.author.person");
    expect(authorKey("peer")).toBe("tabCheckpoints.author.peer");
    expect(authorKey("ags")).toBe("tabCheckpoints.author.app");
    expect(authorKey("ade")).toBe("tabCheckpoints.author.app");
    expect(kindKey("safety")).toBe("tabCheckpoints.kind.safety");
    expect(kindKey("qualquer")).toBe("tabCheckpoints.kind.message");
  });

  it("os bloqueios mostram o título da aba quando ela é conhecida", () => {
    const lines = describeBlockers(
      [{ kind: "tab", id: "a", dir: "/r" }, { kind: "tab", id: "sumida", dir: "/r/x" }, { kind: "task", id: "tk1", dir: "/r" }],
      [{ id: "a", title: "Backend", agentLabel: "Claude" }],
    );
    expect(lines).toEqual([
      { kind: "tab", name: "Backend", dir: "/r" },
      { kind: "tab", name: "sumida", dir: "/r/x" },
      { kind: "task", name: "tk1", dir: "/r" },
    ]);
  });

  it("o ponto que desfaz uma volta é a segurança mais nova depois dele", () => {
    const list = [cp(5, "safety"), cp(4, "message"), cp(3, "safety"), cp(2, "message"), cp(1, "safety")];
    expect(undoFor(list, cp(2, "message"))?.seq).toBe(5);
    expect(undoFor(list, cp(5, "safety"))).toBeNull();
  });

  it("acha as abas que fecharam entre dois estados", () => {
    expect(closedTabs([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }])).toEqual(["a"]);
    expect(closedTabs([{ id: "a" }], [{ id: "a" }])).toEqual([]);
  });

  it("colore o patch como a revisão de missão", () => {
    expect(diffTone("+novo")).toBe("add");
    expect(diffTone("+++ b/x")).toBe("plain");
    expect(diffTone("-velho")).toBe("del");
    expect(diffTone("@@ -1 +1 @@")).toBe("hunk");
    expect(diffTone("diff --git a/x b/x")).toBe("file");
  });
});
