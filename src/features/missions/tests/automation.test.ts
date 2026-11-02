import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("sem backend"))) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { hasPaused, pausedByRestart, type AutomationStatus } from "../automation";
import { pausedNames } from "../AutomationResumeBar";

const status = (patch: Partial<AutomationStatus> = {}): AutomationStatus => ({
  paused: true, bootMs: 10_000, resumedAt: null, missions: [], routines: [], interruptedFixRounds: 0, ...patch,
});

describe("automação depois de reabrir o app", () => {
  it("pausa só o que foi armado antes do boot, e só até retomar", () => {
    expect(pausedByRestart(9_999, status(), false)).toBe(true);
    expect(pausedByRestart(10_000, status(), false)).toBe(false);
    expect(pausedByRestart(1, status({ resumedAt: 12_000 }), false)).toBe(false);
  });

  it("sem resposta do backend: antes de chegar, falha fechada; backend antigo, nada pausa", () => {
    expect(pausedByRestart(500, null, false, 1_000)).toBe(true);
    expect(pausedByRestart(1_500, null, false, 1_000)).toBe(false);
    expect(pausedByRestart(500, null, true, 1_000)).toBe(false);
  });

  it("o botão aparece com algo do backend ou com um time que o Vigia pulou", () => {
    expect(hasPaused({ status: status({ paused: false }), failed: false, vigia: {} })).toBe(false);
    expect(hasPaused({ status: status(), failed: false, vigia: {} })).toBe(true);
    expect(hasPaused({ status: status({ paused: false }), failed: false, vigia: { "c:1": "Conversa" } })).toBe(true);
    expect(hasPaused({ status: status({ resumedAt: 1 }), failed: false, vigia: { "c:1": "Conversa" } })).toBe(false);
    expect(hasPaused({ status: null, failed: true, vigia: { "c:1": "Conversa" } })).toBe(false);
  });

  it("não repete o nome da missão que veio do backend e do Vigia", () => {
    expect(pausedNames([{ title: "Login" }], { m: "Login", "c:2": "Bate-papo" })).toEqual(["Login", "Bate-papo"]);
  });
});
