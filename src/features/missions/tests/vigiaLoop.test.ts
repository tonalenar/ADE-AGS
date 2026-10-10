import { describe, expect, it } from "vitest";

import { LOOP_DONE, LOOP_MS, LOOP_REPORT_MS, loopStep, loopStuck, screenFingerprint, type LoopWatch } from "../vigiaLoop";

const MIN = 60_000;

/** A tela de um Codex no laço: o histórico parado e só o contador de baixo andando. */
const looping = (elapsed: string, tokens = "1,004,278"): string[] => [
  "› rode os testes do backend",
  "",
  "• Ran cargo test --lib",
  "  └ test result: ok. 1332 passed; 0 failed",
  "",
  `◦ Working (${elapsed} • esc to interrupt)`,
  "",
  `  gpt-6.1-sol medium · ${tokens} tokens · 41% context left`,
];

const idle = ["• Pronto, terminei.", "", "› Escreva uma mensagem", "", "  gpt-6.1-sol medium · 41% context left"];

describe("impressão digital da tela", () => {
  it("ignora o que muda sozinho: contador de tempo, tokens e spinner", () => {
    const a = screenFingerprint(looping("5m 04s"));
    const b = screenFingerprint(looping("5m 34s", "1,004,901").map((l) => l.replace("◦", "•")));
    expect(a).toBe(b);
  });

  it("o contador muda de forma com o tempo (5s, 1m 04s, 1h 02m 03s) e continua sendo o mesmo", () => {
    const shapes = ["5s", "1m 04s", "59m 59s", "1h 02m 03s"].map((t) => screenFingerprint(looping(t)));
    expect(new Set(shapes).size).toBe(1);
  });

  it("um número que anda fora das linhas de contador é tela mudando", () => {
    const build = (n: number) => [...looping("3m").slice(0, 4), `  Compiling ${n}/120`, ...looping("3m").slice(4)];
    expect(screenFingerprint(build(34))).not.toBe(screenFingerprint(build(35)));
  });

  it("muda quando aparece conteúdo novo", () => {
    const a = screenFingerprint(looping("5m 04s"));
    const b = screenFingerprint([...looping("5m 34s").slice(0, 4), "• Edited src/lib.rs", ...looping("5m 34s").slice(4)]);
    expect(a).not.toBe(b);
  });
});

describe("vigia do laço do Codex", () => {
  it("só começa a contar quando o agente está em Working", () => {
    expect(loopStep(undefined, idle, 0).next).toBeUndefined();
    expect(loopStep(undefined, null, 0).next).toBeUndefined();
    expect(loopStep(undefined, looping("1s"), 0).next).toEqual({ fingerprint: screenFingerprint(looping("1s")), since: 0 });
  });

  it("avisa quando a tela fica parada por 8 min, uma vez só", () => {
    let watch: LoopWatch | undefined = loopStep(undefined, looping("1s"), 0).next;
    for (let minute = 1; minute < 8; minute += 1) {
      const step = loopStep(watch, looping(`${minute}m`), minute * MIN);
      expect(step.stuckMs).toBeUndefined();
      watch = step.next;
    }
    const due = loopStep(watch, looping("8m 01s"), LOOP_MS);
    expect(due.stuckMs).toBe(LOOP_MS);
    // O ciclo seguinte (30 s depois) não repete o aviso.
    const again = loopStep(due.next, looping("8m 31s"), LOOP_MS + 30_000);
    expect(again.stuckMs).toBeUndefined();
    expect(again.next?.reportedAt).toBe(LOOP_MS);
  });

  it("avisa de novo só depois de 15 min, se continuar parado", () => {
    const first = loopStep({ fingerprint: screenFingerprint(looping("1s")), since: 0 }, looping("9m"), 9 * MIN);
    expect(first.stuckMs).toBe(9 * MIN);
    const soon = loopStep(first.next, looping("20m"), 9 * MIN + LOOP_REPORT_MS - 1);
    expect(soon.stuckMs).toBeUndefined();
    const later = loopStep(first.next, looping("25m"), 9 * MIN + LOOP_REPORT_MS);
    expect(later.stuckMs).toBe(9 * MIN + LOOP_REPORT_MS);
  });

  it("recomeça a contagem quando a tela muda ou o agente sai de Working", () => {
    const watch = { fingerprint: screenFingerprint(looping("1s")), since: 0 };
    const moved = [...looping("9m").slice(0, 4), "• Edited src/lib.rs", ...looping("9m").slice(4)];
    const changed = loopStep(watch, moved, 9 * MIN);
    expect(changed.stuckMs).toBeUndefined();
    expect(changed.next?.since).toBe(9 * MIN);
    expect(loopStep(watch, idle, 9 * MIN)).toEqual({ next: undefined });
    expect(loopStep(watch, null, 9 * MIN)).toEqual({ next: undefined });
  });

  it("um comando longo que escreve a cada minuto não é laço", () => {
    let watch: LoopWatch | undefined;
    for (let minute = 0; minute <= 30; minute += 1) {
      const screen = [...looping(`${minute}m`).slice(0, 4), `  ... compilando crate${minute}`, ...looping(`${minute}m`).slice(4)];
      const step = loopStep(watch, screen, minute * MIN);
      expect(step.stuckMs).toBeUndefined();
      watch = step.next;
    }
  });
});

describe("o aviso do chat", () => {
  it("diz quem, há quanto tempo, e que o agente não foi interrompido", () => {
    expect(loopStuck("Backend", 38.7 * MIN)).toContain("Backend está há 39 min");
    expect(loopStuck("Backend", 1000)).toContain("há 1 min");
    expect(LOOP_DONE).toContain("não interrompi");
  });
});
