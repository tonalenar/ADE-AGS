import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseOpenDesigns, withClosed, withOpened } from "../openStore";

const KEY = "cc-design-open";

/** Um localStorage de mentira: `data` é o que ficou gravado. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
  return { data, storage };
}

/** Carrega o módulo como no início do app: o estado sai do que estiver guardado. */
async function loadStore() {
  vi.resetModules();
  return import("../openStore");
}

describe("parseOpenDesigns", () => {
  it("sem nada guardado, nenhum design aberto", () => {
    expect(parseOpenDesigns(null)).toEqual({});
  });
  it("lixo não derruba: vira nenhum aberto", () => {
    expect(parseOpenDesigns("{não é json")).toEqual({});
    expect(parseOpenDesigns('["d1"]')).toEqual({});
    expect(parseOpenDesigns('"texto"')).toEqual({});
  });
  it("descarta o que não é lista de ids, repete e vazio", () => {
    const raw = JSON.stringify({ "main|a": ["d1", 7, "", "d1"], "main|b": "d2", "main|c": [] });
    expect(parseOpenDesigns(raw)).toEqual({ "main|a": ["d1"] });
  });
});

describe("withOpened e withClosed", () => {
  it("abrir acrescenta no canvas e não mexe nos outros", () => {
    expect(withOpened({ "main|b": ["d9"] }, "main|a", "d1")).toEqual({ "main|b": ["d9"], "main|a": ["d1"] });
  });
  it("abrir de novo o que já está aberto devolve o mesmo objeto", () => {
    const open = { "main|a": ["d1"] };
    expect(withOpened(open, "main|a", "d1")).toBe(open);
  });
  it("fechar tira só aquele design; o último tira o canvas", () => {
    expect(withClosed({ "main|a": ["d1", "d2"] }, "main|a", "d1")).toEqual({ "main|a": ["d2"] });
    expect(withClosed({ "main|a": ["d1"] }, "main|a", "d1")).toEqual({});
  });
  it("fechar o que não estava aberto devolve o mesmo objeto", () => {
    const open = { "main|a": ["d1"] };
    expect(withClosed(open, "main|a", "d7")).toBe(open);
    expect(withClosed(open, "main|z", "d1")).toBe(open);
  });
});

describe("abrir e fechar no canvas, lembrado entre reinícios", () => {
  let mem: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    mem = memoryStorage();
    vi.stubGlobal("localStorage", mem.storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("o que foi aberto volta depois de reiniciar o app", async () => {
    const first = await loadStore();
    first.openDesignOn("main|/proj", "d1");
    expect(JSON.parse(mem.data.get(KEY) ?? "null")).toEqual({ "main|/proj": ["d1"] });
    const restarted = await loadStore();
    expect(restarted.useOpenDesignsStore.getState().open).toEqual({ "main|/proj": ["d1"] });
  });

  it("fechar tira do canvas e do que fica gravado", async () => {
    const store = await loadStore();
    store.openDesignOn("main|/proj", "d1");
    store.openDesignOn("main|/proj", "d2");
    store.closeDesignOn("main|/proj", "d1");
    expect(JSON.parse(mem.data.get(KEY) ?? "null")).toEqual({ "main|/proj": ["d2"] });
    store.closeDesignOn("main|/proj", "d2");
    expect((await loadStore()).useOpenDesignsStore.getState().open).toEqual({});
  });

  it("cada canvas guarda o seu: fechar num não fecha no outro", async () => {
    const store = await loadStore();
    store.openDesignOn("main|/a", "d1");
    store.openDesignOn("main|/b", "d1");
    store.closeDesignOn("main|/a", "d1");
    expect(store.useOpenDesignsStore.getState().open).toEqual({ "main|/b": ["d1"] });
  });

  it("não apaga o que outra janela gravou depois da leitura", async () => {
    const store = await loadStore();
    mem.data.set(KEY, JSON.stringify({ "w2|/b": ["d2"] }));
    store.openDesignOn("main|/a", "d1");
    expect(JSON.parse(mem.data.get(KEY) ?? "null")).toEqual({ "w2|/b": ["d2"], "main|/a": ["d1"] });
    expect(store.useOpenDesignsStore.getState().open).toEqual({ "w2|/b": ["d2"], "main|/a": ["d1"] });
  });

  it("canvas sem pasta não grava nada", async () => {
    const store = await loadStore();
    store.openDesignOn(null, "d1");
    expect(store.useOpenDesignsStore.getState().open).toEqual({});
    expect(mem.data.has(KEY)).toBe(false);
  });

  it("lixo guardado vira nenhum aberto, sem erro", async () => {
    mem.data.set(KEY, "{quebrado");
    expect((await loadStore()).useOpenDesignsStore.getState().open).toEqual({});
  });
});

describe("storage quebrado não derruba o canvas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sem localStorage nenhum, abre e fecha só em memória", async () => {
    vi.stubGlobal("localStorage", undefined);
    const store = await loadStore();
    store.openDesignOn("main|/a", "d1");
    expect(store.useOpenDesignsStore.getState().open).toEqual({ "main|/a": ["d1"] });
    store.closeDesignOn("main|/a", "d1");
    expect(store.useOpenDesignsStore.getState().open).toEqual({});
  });

  it("leitura e gravação que lançam erro: segue funcionando", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("acesso negado"); },
      setItem: () => { throw new Error("cota cheia"); },
    });
    const store = await loadStore();
    expect(store.useOpenDesignsStore.getState().open).toEqual({});
    expect(() => store.openDesignOn("main|/a", "d1")).not.toThrow();
    expect(store.useOpenDesignsStore.getState().open).toEqual({ "main|/a": ["d1"] });
  });
});
