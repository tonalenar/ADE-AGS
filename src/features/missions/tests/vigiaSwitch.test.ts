/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVigiaSwitch, vigiaActive } from "../vigiaSwitch";
import { pokeGuard, vigiaTick } from "../vigia";

describe("interruptor do Vigia", () => {
  beforeEach(() => {
    localStorage.clear();
    useVigiaSwitch.setState({ enabled: false });
  });

  it("começa desligado e liga e desliga pelo botão, guardando a escolha", () => {
    expect(useVigiaSwitch.getState().enabled).toBe(false);
    useVigiaSwitch.getState().toggle();
    expect(useVigiaSwitch.getState().enabled).toBe(true);
    expect(localStorage.getItem("ags.vigia.enabled")).toBe("1");
    useVigiaSwitch.getState().toggle();
    expect(useVigiaSwitch.getState().enabled).toBe(false);
    expect(localStorage.getItem("ags.vigia.enabled")).toBe("0");
  });

  it("desligado, o ciclo do Vigia não faz nada", () => {
    expect(() => vigiaTick(Date.now())).not.toThrow();
  });

  it("checado na hora de agir, com falha fechada", () => {
    useVigiaSwitch.getState().setEnabled(true);
    expect(vigiaActive()).toBe(true);
    // Desligado noutra janela (só o armazenamento mudou): não age.
    localStorage.setItem("ags.vigia.enabled", "0");
    expect(vigiaActive()).toBe(false);
    localStorage.setItem("ags.vigia.enabled", "1");
    // A leitura falhou: em dúvida, não age.
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("bloqueado"); });
    expect(vigiaActive()).toBe(false);
    spy.mockRestore();
    expect(vigiaActive()).toBe(true);
    useVigiaSwitch.getState().setEnabled(false);
    expect(vigiaActive()).toBe(false);
  });

  it("a rechecagem antes de colar exige o Vigia ligado e o destino parado", () => {
    expect(pokeGuard(() => true, () => false)).toBe(true);
    expect(pokeGuard(() => false, () => false)).toBe(false);
    expect(pokeGuard(() => true, () => true)).toBe(false);
  });
});
