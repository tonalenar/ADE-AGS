import { describe, expect, it } from "vitest";

import { defaultDesignId, resolveOwner } from "../owner";

const tabs = [{ id: "orq", title: "Orquestrador" }, { id: "front", title: "Frontend" }, { id: "solta", title: "Terminal" }];
const mission = { orq: "m1", front: "m1" };

describe("resolveOwner", () => {
  it("usa o dono gravado quando a aba existe", () => {
    expect(resolveOwner({ ownerTabId: "front", missionId: "m1" }, tabs, mission)).toBe("front");
  });

  it("sem dono (CLI antigo) ou dono fechado, cai na orquestradora da missão", () => {
    expect(resolveOwner({ ownerTabId: null, missionId: "m1" }, tabs, mission)).toBe("orq");
    expect(resolveOwner({ ownerTabId: "fechada", missionId: "m1" }, tabs, mission)).toBe("orq");
  });

  it("sem orquestradora usa outra aba da missão; sem missão ou sem abas, ninguém", () => {
    expect(resolveOwner({ ownerTabId: null, missionId: "m1" }, [{ id: "front", title: "Frontend" }], mission)).toBe("front");
    expect(resolveOwner({ ownerTabId: null, missionId: null }, tabs, mission)).toBeNull();
    expect(resolveOwner({ ownerTabId: null, missionId: "m2" }, tabs, mission)).toBeNull();
  });
});

describe("defaultDesignId", () => {
  it("prefere o mais recente que tem a quem entregar, em vez do duplicado sem dono", () => {
    const designs = [{ id: "velho", ownerTabId: null, missionId: null }, { id: "novo", ownerTabId: "front", missionId: "m1" }];
    expect(defaultDesignId(designs, tabs, mission)).toBe("novo");
  });

  it("se nenhum tem destino, abre o mais recente; sem designs, nada", () => {
    const designs = [{ id: "a", ownerTabId: null, missionId: null }, { id: "b", ownerTabId: null, missionId: null }];
    expect(defaultDesignId(designs, tabs, mission)).toBe("b");
    expect(defaultDesignId([], tabs, mission)).toBeNull();
  });
});
