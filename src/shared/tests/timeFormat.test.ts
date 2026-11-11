import { describe, expect, it } from "vitest";

import { formatClock, formatTimestamp, isTimeFormat, timeFormatOptions } from "@/shared/timeFormat";

// Horas locais: o `Date` local não depende do fuso da máquina que roda o teste.
const afternoon = new Date(2026, 4, 10, 14, 5).getTime();
const morning = new Date(2026, 4, 10, 9, 7).getTime();

describe("formato de hora", () => {
  it("só aceita os três valores salvos", () => {
    expect(isTimeFormat("locale")).toBe(true);
    expect(isTimeFormat("12-hour")).toBe(true);
    expect(isTimeFormat("24-hour")).toBe(true);
    expect(isTimeFormat("12h")).toBe(false);
    expect(isTimeFormat(null)).toBe(false);
  });

  it("24 horas força o relógio de 24 e o zero à esquerda", () => {
    expect(formatClock(afternoon, "24-hour", "en-US")).toBe("14:05");
    expect(formatClock(morning, "24-hour", "en-US")).toBe("09:07");
  });

  it("12 horas força o relógio de 12 com AM/PM, mesmo num idioma de 24", () => {
    expect(formatClock(afternoon, "12-hour", "pt-BR")).toMatch(/^0?2:05\s?PM$/i);
    expect(formatClock(morning, "12-hour", "pt-BR")).toMatch(/^0?9:07\s?AM$/i);
  });

  it("padrão do sistema deixa o idioma decidir", () => {
    // pt-BR usa 24 horas; o `locale` não força nada.
    expect(formatClock(afternoon, "locale", "pt-BR")).toBe("14:05");
    expect(timeFormatOptions("locale", { hour: "2-digit" })).toEqual({ hour: "2-digit" });
  });

  it("segundos entram só quando pedidos", () => {
    expect(formatClock(afternoon, "24-hour", "en-US", true)).toBe("14:05:00");
    expect(formatClock(afternoon, "24-hour", "en-US")).toBe("14:05");
  });
});

describe("carimbo de hora", () => {
  it("no mesmo dia mostra só a hora", () => {
    expect(formatTimestamp(afternoon, "24-hour", "en-US", afternoon + 60_000)).toBe("14:05");
  });

  it("em outro dia põe a data curta antes da hora", () => {
    const now = afternoon + 3 * 24 * 60 * 60 * 1000;
    const text = formatTimestamp(afternoon, "24-hour", "en-US", now);
    expect(text.endsWith("14:05")).toBe(true);
    expect(text.length).toBeGreaterThan("14:05".length);
  });

  it("vira o dia pelo relógio local: 23:59 e 00:01 são dias diferentes", () => {
    const lateNight = new Date(2026, 4, 10, 23, 59).getTime();
    const justAfterMidnight = new Date(2026, 4, 11, 0, 1).getTime();
    expect(formatTimestamp(lateNight, "24-hour", "en-US", justAfterMidnight)).not.toBe("23:59");
  });
});
