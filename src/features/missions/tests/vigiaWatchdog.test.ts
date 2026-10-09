/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { LEAD_SILENT_MS, NUDGE_LIMIT, OPEN_TASK_MS, UNTASKED_MS, VIGIA_COOLDOWN_MS, missionStartMs, reportLine, watchdogFinding, type WatchInput } from "../vigia";

const MIN = 60_000;

/** Um começo com o Orquestrador falando no minuto 1, Backend sem tarefa e QA já trabalhando. */
function scene(over: Partial<WatchInput> = {}): WatchInput {
  return {
    now: 6 * MIN,
    startedAt: 0,
    lead: { id: "lead", name: "Orquestrador", lastOutput: 1 * MIN },
    members: [
      { id: "b", name: "Backend", hasTask: false },
      { id: "q", name: "QA", hasTask: true, lastOutput: 5 * MIN },
    ],
    leadLastSent: 1 * MIN,
    nudges: 0,
    ...over,
  };
}

describe("Vigia: travas que ele destrava sem modelo", () => {
  it("lembra o Orquestrador quando um integrante segue sem tarefa e ele não manda nada há um tempo", () => {
    const finding = watchdogFinding(scene());
    expect(finding?.kind).toBe("untasked");
    expect(finding?.stuck).toContain("Backend");
    expect(finding && finding.kind !== "limit" ? finding.nudge : "").toContain("--file");
  });

  it("não lembra enquanto o Orquestrador ainda está delegando", () => {
    // Mandou há pouco: ainda dentro da janela de UNTASKED_MS, e a equipe está ativa.
    expect(watchdogFinding(scene({ now: 4 * MIN, leadLastSent: 3 * MIN, lead: { id: "lead", name: "Orquestrador", lastOutput: 3 * MIN } }))).toBeNull();
  });

  it("espera o cooldown entre lembretes e para no limite, com o que travou", () => {
    expect(watchdogFinding(scene({ lastNudge: 5 * MIN }))).toBeNull();
    const capped = watchdogFinding(scene({ nudges: NUDGE_LIMIT }));
    expect(capped?.kind).toBe("limit");
    expect(capped?.stuck).toContain("Backend");
    expect(VIGIA_COOLDOWN_MS).toBeGreaterThan(0);
  });

  it("equipe toda quieta sem o Orquestrador falar é travado mesmo com todos com tarefa", () => {
    const quiet = scene({
      now: 25 * MIN,
      leadLastSent: 1 * MIN,
      lead: { id: "lead", name: "Orquestrador", lastOutput: 1 * MIN },
      members: [
        { id: "b", name: "Backend", hasTask: true, lastOutput: 2 * MIN },
        { id: "q", name: "QA", hasTask: true, lastOutput: 2 * MIN },
      ],
    });
    const finding = watchdogFinding(quiet);
    expect(finding?.kind).toBe("silent");
    expect(finding?.stuck).toContain(`${LEAD_SILENT_MS / MIN} min`);
  });

  it("cobra o status de quem está há muito na mesma tarefa sem reportar", () => {
    // Reviewer recebeu a tarefa no minuto 10 e não mandou nada; a equipe ainda escreve (não é "parado").
    const open = watchdogFinding(
      scene({
        now: 10 * MIN + OPEN_TASK_MS,
        leadLastSent: 9 * MIN,
        lead: { id: "lead", name: "Orquestrador", lastOutput: 9 * MIN },
        members: [{ id: "r", name: "Reviewer", hasTask: true, taskAt: 10 * MIN, lastOutput: 10 * MIN + OPEN_TASK_MS - 1000 }],
      }),
    );
    expect(open?.kind).toBe("open");
    expect(open && open.kind !== "limit" ? open.stuck : "").toContain("Reviewer");
    // Se ele já reportou depois da tarefa, não é mais "aberta".
    expect(
      watchdogFinding(
        scene({
          now: 10 * MIN + OPEN_TASK_MS,
          leadLastSent: 9 * MIN,
          lead: { id: "lead", name: "Orquestrador", lastOutput: 9 * MIN },
          members: [{ id: "r", name: "Reviewer", hasTask: true, taskAt: 10 * MIN, reportedAt: 20 * MIN, lastOutput: 10 * MIN + OPEN_TASK_MS - 1000 }],
        }),
      ),
    ).toBeNull();
  });

  it("um integrante que segue trabalhando não é travado", () => {
    const busy = scene({
      now: 25 * MIN,
      leadLastSent: 1 * MIN,
      members: [
        { id: "b", name: "Backend", hasTask: true, lastOutput: 24 * MIN },
        { id: "q", name: "QA", hasTask: true, lastOutput: 2 * MIN },
      ],
    });
    expect(watchdogFinding(busy)).toBeNull();
    expect(UNTASKED_MS).toBeGreaterThan(0);
  });

  it("o relatório do chat diz o que travou e o que foi feito", () => {
    expect(reportLine("Backend sem tarefa.", "lembrete 1/3 enviado.")).toBe("**Vigia** — travado: Backend sem tarefa. Feito: lembrete 1/3 enviado.");
  });
});

describe("Vigia: início da missão vem do banco em segundos", () => {
  // missions.started_at é epoch em SEGUNDOS: 1791568168 = 09/10/2026 14:49:28 (horário local).
  const STARTED_SEC = 1791568168;
  const START = STARTED_SEC * 1000;

  it("missionStartMs converte segundos em milissegundos e usa o agora quando não há início", () => {
    expect(missionStartMs(STARTED_SEC, START + 30_000)).toBe(START);
    expect(missionStartMs(null, 42)).toBe(42);
  });

  it("com início realista em segundos, nenhum aviso 'sem tarefa' antes de UNTASKED_MS", () => {
    // Equipe ativa (todos escrevendo agora), Backend ainda sem tarefa, Orquestrador sem delegar.
    const at = (now: number): WatchInput => ({
      now,
      startedAt: missionStartMs(STARTED_SEC, now),
      lead: { id: "lead", name: "Orquestrador", lastOutput: now },
      members: [{ id: "b", name: "Backend", hasTask: false, lastOutput: now }],
      nudges: 0,
    });
    // Primeiro ciclo do Vigia (30 s) e logo antes do limite: nada.
    expect(watchdogFinding(at(START + 30_000))).toBeNull();
    expect(watchdogFinding(at(START + UNTASKED_MS - 1))).toBeNull();
    // Passado o limite, aí sim.
    expect(watchdogFinding(at(START + UNTASKED_MS))?.kind).toBe("untasked");
  });
});
