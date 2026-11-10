import { describe, expect, it } from "vitest";

import { browserScope, closeTab, moveTab, openTab, panelOfActive, pickResource, reconcileColumn, tabLabelKey, type ColumnState, type ColumnTab } from "../columnTabs";

const tab = (id: string, kind: ColumnTab["kind"], resources?: Record<string, string>): ColumnTab => ({ id, kind, ...(resources ? { resources } : {}) });
const empty: ColumnState = { tabs: [], active: null };

describe("abrir abas da coluna", () => {
  it("a primeira aba nasce ativa; superfície de uma aba só (Arquivos) foca a que existe em vez de repetir", () => {
    const one = openTab(empty, "files");
    expect(one.tabs.map((t) => t.kind)).toEqual(["files"]);
    expect(one.active).toBe(one.id);
    const again = openTab({ tabs: one.tabs, active: null }, "files");
    expect(again.tabs).toHaveLength(1);
    expect(again.active).toBe(one.id);
  });

  it("navegador e terminal aceitam várias abas com forceNew (o + do T3); sem forceNew focam a existente", () => {
    let s: ColumnState = empty;
    s = openTab(s, "browser", { forceNew: true });
    s = openTab(s, "browser", { forceNew: true });
    s = openTab(s, "shell", { forceNew: true });
    s = openTab(s, "shell", { forceNew: true });
    expect(s.tabs.map((t) => t.kind)).toEqual(["browser", "browser", "shell", "shell"]);
    expect(s.active).toBe(s.tabs[3]!.id);
    const focus = openTab(s, "browser");
    expect(focus.tabs).toHaveLength(4);
    expect(focus.active).toBe(s.tabs[0]!.id);
  });

  it("forceNew não duplica as superfícies de uma aba só e carrega o perfil do submenu do Browser", () => {
    const one = openTab(empty, "diff");
    expect(openTab(one, "diff", { forceNew: true }).tabs).toHaveLength(1);
    const withProfile = openTab(empty, "browser", { forceNew: true, profileId: "profile-x" });
    expect(withProfile.tabs[0]!.profileId).toBe("profile-x");
  });

  it("focar o navegador com dois abertos mantém o que já está ativo", () => {
    const s: ColumnState = { tabs: [tab("a", "browser"), tab("b", "browser")], active: "b" };
    expect(openTab(s, "browser").active).toBe("b");
  });
});

describe("fechar e reordenar", () => {
  const s: ColumnState = { tabs: [tab("a", "browser"), tab("b", "shell"), tab("c", "files")], active: "b" };

  it("fechar a ativa passa para a vizinha da direita; a última passa para a da esquerda; a única deixa o vazio", () => {
    expect(closeTab(s, "b").active).toBe("c");
    expect(closeTab({ ...s, active: "c" }, "c").active).toBe("b");
    expect(closeTab({ tabs: [tab("a", "diff")], active: "a" }, "a")).toEqual({ tabs: [], active: null });
  });

  it("fechar outra aba não muda a ativa; id desconhecido não faz nada", () => {
    expect(closeTab(s, "a")).toEqual({ tabs: s.tabs.slice(1), active: "b" });
    expect(closeTab(s, "zzz")).toBe(s);
  });

  it("mover leva a aba para o índice pedido (preso nas pontas); sem mudança devolve a mesma lista", () => {
    expect(moveTab(s.tabs, "c", 0).map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(moveTab(s.tabs, "a", 99).map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(moveTab(s.tabs, "a", 0)).toBe(s.tabs);
    expect(moveTab(s.tabs, "zzz", 0)).toBe(s.tabs);
  });
});

describe("reconciliar com o `panel`", () => {
  it("painel numa superfície sem aba cria a aba; com abas dela, ativa a primeira; já certo = nada a fazer", () => {
    const created = reconcileColumn("files", empty)!;
    expect(created.tabs.map((t) => t.kind)).toEqual(["files"]);
    expect(created.active).toBe(created.tabs[0]!.id);
    const s: ColumnState = { tabs: [tab("a", "browser"), tab("b", "browser")], active: "a" };
    expect(reconcileColumn("browser", { ...s, active: "b" })).toBeNull();
    expect(reconcileColumn("browser", { ...s, active: null })!.active).toBe("a");
  });

  it("vazio desativa a aba; fechado não mexe (reabrir volta na aba que estava)", () => {
    const s: ColumnState = { tabs: [tab("a", "diff")], active: "a" };
    expect(reconcileColumn("empty", s)).toEqual({ tabs: s.tabs, active: null });
    expect(reconcileColumn("empty", { ...s, active: null })).toBeNull();
    expect(reconcileColumn(null, s)).toBeNull();
  });

  it("o panel da aba ativa: a superfície dela, ou vazio", () => {
    expect(panelOfActive({ tabs: [tab("a", "pr")], active: "a" })).toBe("pr");
    expect(panelOfActive(empty)).toBe("empty");
  });
});

describe("o recurso de cada aba (página/shell) por conversa", () => {
  const scope = browserScope("/repo", { kind: "tab", id: "t1" });

  it("prefere o que a aba já guardou; senão o primeiro candidato que outra aba não reservou", () => {
    const tabs = [tab("a", "browser", { [scope]: "v1" }), tab("b", "browser")];
    expect(pickResource(tabs[0], scope, ["v1", "v2"], tabs)).toBe("v1");
    expect(pickResource(tabs[1], scope, ["v1", "v2"], tabs)).toBe("v2");
    expect(pickResource(tabs[1], scope, ["v1"], tabs)).toBeNull();
  });

  it("o recurso guardado que sumiu não vale; escopos de conversas diferentes não se misturam", () => {
    const other = browserScope("/repo", { kind: "tab", id: "t2" });
    const tabs = [tab("a", "browser", { [scope]: "gone", [other]: "v9" })];
    expect(pickResource(tabs[0], scope, ["v1"], tabs)).toBe("v1");
    expect(pickResource(tabs[0], other, ["v9"], tabs)).toBe("v9");
    expect(browserScope("/repo", null)).toBe("user|/repo");
  });

  it("duas abas na mesma conversa nunca mostram a mesma página", () => {
    const tabs = [tab("a", "browser", { [scope]: "v1" }), tab("b", "browser")];
    const b = pickResource(tabs[1], scope, ["v1", "v2"], tabs);
    const a = pickResource(tabs[0], scope, ["v1", "v2"], [tabs[0]!, tab("b", "browser", { [scope]: b! })]);
    expect(new Set([a, b]).size).toBe(2);
  });
});

describe("o nome da aba", () => {
  it("numera a partir da segunda do mesmo tipo; a única não leva número", () => {
    const tabs = [tab("a", "shell"), tab("b", "shell"), tab("c", "files")];
    expect(tabLabelKey(tabs[0]!, tabs)).toEqual({ key: "chat.panel.tab.shell", index: 1 });
    expect(tabLabelKey(tabs[1]!, tabs)).toEqual({ key: "chat.panel.tab.shell", index: 2 });
    expect(tabLabelKey(tabs[2]!, tabs)).toEqual({ key: "chat.panel.tab.files", index: 0 });
  });
});
