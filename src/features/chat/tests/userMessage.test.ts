import { describe, expect, it } from "vitest";

import { parsePeerEnvelope } from "../timeline/peerEnvelope";
import { pendingSend, unreconciled } from "../timeline/pending";
import { isInfraCommand, timelineTurns } from "../timeline/timelineModel";
import type { TimelineItem } from "../timeline/types";
import { displayUserText, isSystemInjection } from "../timeline/userMessage";

const NOTICE = "[ADE AGS] Você é o orquestrador deste time: Codex · Revisor (codex; Revisor; acesso total, team/reviewer). Delegue em ~2 min com `ags peer tell <nome>` e encerre o turno. Use `ags team list` para ver o time.";
const user = (id: string, text: string, at?: number): TimelineItem => ({ kind: "user", id, text, at });
const cmd = (id: string, label: string): TimelineItem => ({ kind: "tool", id, tool: "command", label, status: "done" });

describe("isSystemInjection", () => {
  it("reconhece [ADE AGS] e não confunde com o envelope de peer", () => {
    expect(isSystemInjection(NOTICE)).toBe(true);
    expect(isSystemInjection("  [ADE AGS] Você entrou no time de Claude Code")).toBe(true);
    const peer = "[Mensagem de Codex · Revisor via ADE AGS] aviso\n<untrusted_data>\noi\n</untrusted_data>";
    expect(isSystemInjection(peer)).toBe(false);
    expect(parsePeerEnvelope(peer)?.body).toBe("oi");
    expect(displayUserText(peer)).toBe(peer);
  });
});

describe("displayUserText", () => {
  it("esconde a injeção pura", () => {
    expect(displayUserText(NOTICE)).toBeNull();
    expect(displayUserText("[ADE AGS] Você entrou no time como Backend.\nTrabalhe só na sua branch.\n\nOutro parágrafo")).toBeNull();
  });
  it("tira só o resumo do time colado na frente do texto da pessoa", () => {
    expect(displayUserText(`${NOTICE}\n\nfaça o login`)).toBe("faça o login");
  });
  it("tira o prefixo do 'Só o orquestrador'", () => {
    expect(displayUserText("[Só o orquestrador] Responda você mesmo, sem delegar ao time:\nolá")).toBe("olá");
  });
  it("não mexe no texto comum", () => {
    expect(displayUserText("rode os testes")).toBe("rode os testes");
  });
});

describe("pending com prefixo", () => {
  it("o eco com o prefixo concilia com o que a pessoa digitou", () => {
    const sent = "[Só o orquestrador] Responda você mesmo, sem delegar ao time:\nolá";
    const p = pendingSend("p", sent, [], 1);
    expect(unreconciled([p], [user("u", sent)], 2)).toEqual([]);
  });
});

describe("isInfraCommand", () => {
  it("pega ags de infraestrutura em qualquer ponto do comando", () => {
    expect(isInfraCommand(cmd("1", "ags peers"))).toBe(true);
    expect(isInfraCommand(cmd("2", "s=$(python3 -c 'import time'); ags peer ask x --task y"))).toBe(true);
    expect(isInfraCommand(cmd("3", "bun run test"))).toBe(false);
    expect(isInfraCommand(cmd("4", "echo flags peers"))).toBe(false);
  });
});

describe("timelineTurns com bastidores", () => {
  it("injeção vira turno sem bolha e comandos ags viram uma linha infra", () => {
    const [turn] = timelineTurns([
      user("u1", NOTICE, 1000),
      cmd("t1", "ags peers"),
      cmd("t2", "ags roles"),
      { kind: "tool", id: "t3", tool: "read", status: "done" },
      { kind: "assistant", id: "a1", text: "ok" },
      { kind: "turnEnd", id: "e1", at: 6000 },
    ]);
    expect(turn!.user).toBeNull();
    expect(turn!.body.map((r) => r.type)).toEqual(["infra", "work"]);
    expect(turn!.end?.durationMs).toBe(5000);
  });
});
