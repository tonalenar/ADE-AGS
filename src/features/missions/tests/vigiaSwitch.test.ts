/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from "vitest";
import { useVigiaSwitch } from "../vigiaSwitch";
import { vigiaTick } from "../vigia";

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
});
