import { describe, expect, it } from "vitest";

import { checkDraft, emptyDraft, normalizeText, relativeFrom, summarize, toLocalInput, type Draft } from "../routineModel";

// Um relógio fixo: 5 de outubro de 2026, 12:00 local.
const NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();

function draft(over: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(NOW, null), name: "Testes", text: "rode os testes", ...over };
}

/** Um tradutor de mentira: devolve a chave e as variáveis, para checar o que a frase recebe. */
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

describe("checkDraft: nome e texto", () => {
  it("nome é obrigatório e tem até 40 caracteres", () => {
    expect(checkDraft(draft({ name: "  " }), NOW).errors.name).toBe("canvas.routines.err.name");
    expect(checkDraft(draft({ name: "a".repeat(40) }), NOW).errors.name).toBeUndefined();
    expect(checkDraft(draft({ name: "a".repeat(41) }), NOW).errors.name).toBe("canvas.routines.err.nameLong");
  });

  it("texto é obrigatório, conta depois de achatado e tem até 1000", () => {
    expect(checkDraft(draft({ text: " \n\t " }), NOW).errors.text).toBe("canvas.routines.err.text");
    expect(checkDraft(draft({ text: "x".repeat(1000) }), NOW).errors.text).toBeUndefined();
    expect(checkDraft(draft({ text: "x".repeat(1001) }), NOW).errors.text).toBe("canvas.routines.err.textLong");
  });

  it("normalizeText achata quebras e colapsa espaços, como o backend", () => {
    expect(normalizeText("  rode\n os\t testes   agora ")).toBe("rode os testes agora");
  });
});

describe("checkDraft: intervalo", () => {
  it("mínimo de 5 minutos", () => {
    const short = checkDraft(draft({ kind: "every", amount: "4", unit: "min" }), NOW);
    expect(short.schedule).toBeNull();
    expect(short.errors.schedule).toBe("canvas.routines.err.every");
    expect(checkDraft(draft({ kind: "every", amount: "5", unit: "min" }), NOW).schedule).toEqual({ kind: "every", secs: 300 });
  });

  it("em horas e quantidades inválidas", () => {
    expect(checkDraft(draft({ kind: "every", amount: "2", unit: "h" }), NOW).schedule).toEqual({ kind: "every", secs: 7200 });
    expect(checkDraft(draft({ kind: "every", amount: "0", unit: "h" }), NOW).errors.schedule).toBe("canvas.routines.err.amount");
    expect(checkDraft(draft({ kind: "every", amount: "1.5", unit: "h" }), NOW).errors.schedule).toBe("canvas.routines.err.amount");
    expect(checkDraft(draft({ kind: "every", amount: "", unit: "min" }), NOW).errors.schedule).toBe("canvas.routines.err.amount");
  });
});

describe("checkDraft: todo dia e uma vez", () => {
  it("diária: dias ordenados e sem repetidos; vazio = todos", () => {
    const r = checkDraft(draft({ kind: "daily", hour: 9, minute: 0, days: [4, 0, 4] }), NOW);
    expect(r.schedule).toEqual({ kind: "daily", hour: 9, minute: 0, days: [0, 4] });
    expect(checkDraft(draft({ kind: "daily", hour: 9, minute: 0, days: [] }), NOW).schedule).toEqual({
      kind: "daily", hour: 9, minute: 0, days: [],
    });
  });

  it("uma vez: precisa estar no futuro com 1 minuto de folga", () => {
    const soon = checkDraft(draft({ kind: "once", onceAt: toLocalInput(new Date(NOW + 30_000)) }), NOW);
    expect(soon.errors.schedule).toBe("canvas.routines.err.past");
    const past = checkDraft(draft({ kind: "once", onceAt: toLocalInput(new Date(NOW - 60_000)) }), NOW);
    expect(past.errors.schedule).toBe("canvas.routines.err.past");
    const later = checkDraft(draft({ kind: "once", onceAt: toLocalInput(new Date(NOW + 45 * 60_000)) }), NOW);
    expect(later.schedule).toEqual({ kind: "once", at: Math.floor(NOW / 1000) + 45 * 60 });
  });

  it("uma vez sem data", () => {
    expect(checkDraft(draft({ kind: "once", onceAt: "" }), NOW).errors.schedule).toBe("canvas.routines.err.onceEmpty");
  });
});

describe("summarize", () => {
  it("sem texto ou com horário inválido, não há frase", () => {
    expect(summarize(draft({ text: "" }), null, t, NOW)).toBeNull();
    expect(summarize(draft({ kind: "every", amount: "1", unit: "min" }), null, t, NOW)).toBeNull();
  });

  it("para um agente: diz o texto, quem recebe e o horário", () => {
    const s = summarize(draft({ kind: "daily", hour: 9, minute: 0, days: [] }), "Claude A", t, NOW);
    expect(s).toContain("canvas.routines.sum.toAgent");
    expect(s).toContain('"agent":"Claude A"');
    expect(s).toContain('"text":"rode os testes"');
    expect(s).toContain("canvas.routines.sched.daily");
  });

  it("lembrete: sem agente, o horário de uma vez com dia e hora", () => {
    const s = summarize(draft({ kind: "once", onceAt: "2026-10-05T14:30" }), null, t, NOW);
    expect(s).toContain("canvas.routines.sum.toMe");
    expect(s).toContain("05/10 14:30");
  });

  it("corta um texto muito longo na frase", () => {
    const s = summarize(draft({ text: "x".repeat(200), kind: "every", amount: "2", unit: "h" }), null, t, NOW) ?? "";
    expect(s).toContain("x".repeat(79) + "…");
  });
});

describe("relativeFrom", () => {
  it("menos de um minuto é agora", () => {
    expect(relativeFrom(NOW / 1000 + 30, NOW, "en-US")).toBeNull();
  });

  it("minutos e horas, no idioma", () => {
    expect(relativeFrom(NOW / 1000 + 45 * 60, NOW, "en-US")).toBe("in 45 minutes");
    expect(relativeFrom(NOW / 1000 + 2 * 3600, NOW, "en-US")).toBe("in 2 hours");
  });
});
