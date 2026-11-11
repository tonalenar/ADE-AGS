import { describe, expect, it } from "vitest";

import { DEFAULT_PROJECT_ORDER_PREFS, moveInOrder, orderProjects, recordFirstSeen, type ProjectOrderPrefs } from "../sidebar/projectOrder";

const entry = (key: string, latest: number) => ({ key, latest });
const prefs = (over: Partial<ProjectOrderPrefs>): ProjectOrderPrefs => ({ ...DEFAULT_PROJECT_ORDER_PREFS, ...over });

describe("ordem dos projetos na barra", () => {
  const entries = [entry("/p/a", 10), entry("/p/b", 30), entry("/p/c", 20)];

  it("por padrão, o último pedido seu fica em cima (como a barra sempre fez)", () => {
    expect(orderProjects(entries, DEFAULT_PROJECT_ORDER_PREFS).map((e) => e.key)).toEqual(["/p/b", "/p/c", "/p/a"]);
  });

  it("criado em: o projeto que apareceu por último fica em cima, e o que não tem data vai para o fim", () => {
    const created = { "/p/a": 100, "/p/b": 300, "/p/c": 200 };
    expect(orderProjects(entries, prefs({ mode: "created", created })).map((e) => e.key)).toEqual(["/p/b", "/p/c", "/p/a"]);
    // Sem data nenhuma, o desempate é o último pedido (o mesmo critério do padrão).
    expect(orderProjects(entries, prefs({ mode: "created" })).map((e) => e.key)).toEqual(["/p/b", "/p/c", "/p/a"]);
  });

  it("manual: segue a ordem escolhida, e projeto novo (fora da lista) entra antes, como nas conversas", () => {
    const manual = ["/p/a", "/p/c", "/p/b"];
    const novo = [...entries, entry("/p/novo", 1)];
    expect(orderProjects(novo, prefs({ mode: "manual", manual })).map((e) => e.key)).toEqual(["/p/novo", "/p/a", "/p/c", "/p/b"]);
  });

  it("manual: os que estão fora da lista ficam antes, entre eles pelo último pedido", () => {
    const manual = ["/p/a"];
    expect(orderProjects(entries, prefs({ mode: "manual", manual })).map((e) => e.key)).toEqual(["/p/b", "/p/c", "/p/a"]);
  });

  it("não muda a lista de entrada", () => {
    const before = [...entries];
    orderProjects(entries, prefs({ mode: "manual", manual: ["/p/c"] }));
    expect(entries).toEqual(before);
  });
});

describe("mover um projeto na ordem manual", () => {
  it("sobe e desce trocando com a vizinha", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("no limite, ou para uma chave fora da lista, não muda nada", () => {
    expect(moveInOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], "b", 1)).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], "z", 1)).toEqual(["a", "b"]);
  });
});

describe("data de aparecimento dos projetos", () => {
  it("anota só quem ainda não tem data, e nunca muda a data de quem já tem", () => {
    const antes = { "/p/a": 100 };
    const depois = recordFirstSeen(antes, ["/p/a", "/p/b"], 500);
    expect(depois).toEqual({ "/p/a": 100, "/p/b": 500 });
    expect(antes).toEqual({ "/p/a": 100 });
  });
});
