import { describe, expect, it } from "vitest";

import { speakerHeaders } from "../timeline/speakers";
import type { TimelineItem } from "../timeline/types";

const person = (id: string, text = "oi"): TimelineItem => ({ kind: "user", id, text });
const peer = (id: string, sender: string): TimelineItem => ({ kind: "user", id, text: `[Mensagem de ${sender} via ADE AGS] aviso\n<untrusted_data source="peer:${sender}">\ncorpo\n</untrusted_data>` });
const self = (id: string): TimelineItem => ({ kind: "assistant", id, text: "resposta" });
const tool = (id: string): TimelineItem => ({ kind: "tool", id, tool: "command", label: "ls", status: "done" });

describe("quem fala e quando aparece o logo e o nome acima do texto", () => {
  it("a conversa de um agente só: a primeira fala depois da pessoa leva o cabeçalho; as seguidas (com ferramentas no meio) não", () => {
    const shown = speakerHeaders([person("u"), self("a1"), tool("t"), self("a2"), person("u2"), self("a3")]);
    expect([...shown]).toEqual(["a1", "a3"]);
  });

  it("a mensagem da pessoa nunca leva cabeçalho (ela é o balão)", () => {
    expect(speakerHeaders([person("u"), person("u2")]).size).toBe(0);
  });

  it("a fala de outro agente (envelope do peer) leva o cabeçalho; as seguidas do mesmo remetente, só a primeira", () => {
    const shown = speakerHeaders([self("a1"), peer("p1", "Codex · Backend"), peer("p2", "Codex · Backend"), peer("p3", "Kimi · Testes")]);
    expect([...shown]).toEqual(["a1", "p1", "p3"]);
  });

  it("quando o agente da conversa volta a falar depois de outro, ele ganha o cabeçalho para marcar a troca", () => {
    const shown = speakerHeaders([self("a1"), peer("p1", "Codex"), self("a2"), self("a3")]);
    expect([...shown]).toEqual(["a1", "p1", "a2"]);
  });

  it("a pessoa falando no meio zera a sequência: o agente que responde leva o cabeçalho de novo", () => {
    const shown = speakerHeaders([peer("p1", "Codex"), person("u"), self("a1")]);
    expect([...shown]).toEqual(["p1", "a1"]);
  });

  it("o outro agente logo depois da pessoa leva cabeçalho; ferramentas não contam como fala", () => {
    const shown = speakerHeaders([person("u"), tool("t"), peer("p1", "Codex")]);
    expect([...shown]).toEqual(["p1"]);
  });

  it("começar a conversa já com a fala de outro agente mostra o nome dele", () => {
    expect([...speakerHeaders([peer("p1", "Codex")])]).toEqual(["p1"]);
  });
});
