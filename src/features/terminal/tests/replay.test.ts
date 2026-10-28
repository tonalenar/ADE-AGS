import { describe, expect, it } from "vitest";

import { fixtureErrors, replayTs, timeline, type Mismatch, type ReplayFixture } from "./replayHarness";

/** Todas as fixtures (o Rust lê a mesma pasta). Pelo glob, o `vitest related` acha este teste quando uma muda. */
const FIXTURES = import.meta.glob<ReplayFixture>("./fixtures/replay/*.json", { eager: true, import: "default" });
const all = Object.entries(FIXTURES).map(([path, fixture]) => ({ file: path.split("/").pop() ?? path, fixture }));

function explain(mismatches: Mismatch[]): string {
  return mismatches
    .map((m) => m.xfail
      ? `  ${m.atMs} ms "${m.label}": ${m.key} já acerta (${String(m.actual)}). Tire "${m.key}" do xfail.ts`
      : `  ${m.atMs} ms "${m.label}": ${m.key} esperado ${String(m.expected)}, veio ${String(m.actual)}`)
    .join("\n");
}

describe("fixtures de replay", () => {
  it("existem e têm o formato v1", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const { file, fixture } of all) {
      expect(fixtureErrors(fixture), file).toEqual([]);
      expect(`${fixture.id}.json`, "o id é o nome do arquivo").toBe(file);
    }
  });
});

describe("o próprio harness", () => {
  const base: ReplayFixture = {
    format: "ade-replay", version: 1, id: "x", agent: "codex", title: "x",
    origin: { kind: "synthesized", basis: "teste do harness", recordedAt: null, platform: null, tuiVersion: null },
    terminal: { cols: 80, rows: 10 },
    chunks: [{ atMs: 0, data: "\x1b[1mWorking\x1b[0m (1s • esc to interrupt)" }],
    checkpoints: [],
  };

  it("acusa a expectativa errada e o xfail que já acerta", async () => {
    const mismatches = await replayTs({
      ...base,
      checkpoints: [
        { atMs: 10, expect: { working: false } },
        { atMs: 10, expect: { working: true }, xfail: { ts: ["working"], reason: "x" } },
        { atMs: 10, expect: { working: true, enterRetry: true }, since: 0 },
      ],
    });
    expect(mismatches.map((m) => [m.key, m.xfail])).toEqual([["working", false], ["working", true]]);
  });

  it("recusa chave desconhecida, pedaço sem bytes e xfail sem motivo", () => {
    const errors = fixtureErrors({
      ...base,
      chunks: [{ atMs: 0 }],
      checkpoints: [{ atMs: 1, expect: { workng: true, fresh: false }, xfail: { rust: ["working"], reason: "" } }],
    });
    expect(errors.join("\n")).toMatch(/exatamente um de data\/b64/);
    expect(errors.join("\n")).toMatch(/chave desconhecida "workng"/);
    expect(errors.join("\n")).toMatch(/"fresh" precisa de since/);
    expect(errors.join("\n")).toMatch(/xfail sem reason/);
  });
});

describe("replay pelos detectores do front (xterm real, relógio falso)", () => {
  for (const { fixture } of all) {
    it(`${fixture.id} (${fixture.origin.kind})`, async () => {
      if (process.env.REPLAY_TIMELINE) process.stderr.write(`\n${fixture.id}\n${await timeline(fixture)}\n`);
      const mismatches = await replayTs(fixture);
      expect(mismatches, `${fixture.title}\n${explain(mismatches)}`).toEqual([]);
    });
  }
});
