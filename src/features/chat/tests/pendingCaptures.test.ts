import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "cc-pending-captures";

/** Armazenamento de mentira. `broken` simula um navegador que nega acesso (janela privada, dados bloqueados). */
function fakeStorage(broken = false) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => {
      if (broken) throw new Error("acesso negado");
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (broken) throw new Error("acesso negado");
      data.set(key, value);
    },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
}

let storage = fakeStorage();

/** Um módulo novo a cada chamada: o mesmo efeito de recarregar a janela (memória zerada, armazenamento mantido). */
async function loadModel() {
  vi.resetModules();
  return import("../attachments/pendingCaptures");
}

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePendingCaptures", () => {
  it("lixo no armazenamento vira lista vazia, sem exceção", async () => {
    const { parsePendingCaptures } = await loadModel();
    expect(parsePendingCaptures(null)).toEqual([]);
    expect(parsePendingCaptures("não é uma lista")).toEqual([]);
    expect(parsePendingCaptures({ path: "/a.png" })).toEqual([]);
  });

  it("mantém só as entradas bem formadas", async () => {
    const { parsePendingCaptures } = await loadModel();
    const good = { path: "/Imagens/ADE AGS/a.png", target: "thread:1", kind: "snapshot", savedAt: 10 };
    expect(parsePendingCaptures([
      good,
      { path: "", target: "thread:1", kind: "snapshot", savedAt: 11 },
      { path: "/b.png", target: "thread:1", kind: "video", savedAt: 12 },
      { path: "/c.png", target: null, kind: "snapshot", savedAt: 13 },
      { path: "/d.png", target: "thread:1", kind: "recording", savedAt: Number.NaN },
    ])).toEqual([good]);
  });
});

describe("rememberPendingCapture e pendingCapturePaths", () => {
  it("devolve só as capturas do alvo, na ordem em que foram feitas", async () => {
    const { rememberPendingCapture, pendingCapturePaths } = await loadModel();
    rememberPendingCapture({ path: "/a.png", target: "t1", kind: "snapshot" });
    rememberPendingCapture({ path: "/b.png", target: "t2", kind: "snapshot" });
    rememberPendingCapture({ path: "/c.mov", target: "t1", kind: "recording" });
    expect(pendingCapturePaths("t1")).toEqual(["/a.png", "/c.mov"]);
    expect(pendingCapturePaths("t2")).toEqual(["/b.png"]);
    expect(pendingCapturePaths("outro")).toEqual([]);
  });

  it("sem alvo não guarda nada: não há conversa para devolver a captura", async () => {
    const { rememberPendingCapture, pendingCapturePaths } = await loadModel();
    const result = rememberPendingCapture({ path: "/a.png", target: null, kind: "snapshot" });
    expect(result.dropped).toBeNull();
    expect(pendingCapturePaths(null)).toEqual([]);
    expect(storage.data.has(KEY)).toBe(false);
  });

  it("não repete o mesmo caminho no mesmo alvo", async () => {
    const { rememberPendingCapture, pendingCapturePaths } = await loadModel();
    rememberPendingCapture({ path: "/a.png", target: "t1", kind: "snapshot" });
    rememberPendingCapture({ path: "/a.png", target: "t1", kind: "snapshot" });
    expect(pendingCapturePaths("t1")).toEqual(["/a.png"]);
  });

  it("passado o limite, descarta a mais antiga e a devolve para o aviso", async () => {
    const { rememberPendingCapture, pendingCapturePaths, MAX_PENDING_CAPTURES } = await loadModel();
    for (let i = 0; i < MAX_PENDING_CAPTURES; i++) {
      rememberPendingCapture({ path: `/c${i}.png`, target: "t1", kind: "snapshot" }, i);
    }
    const result = rememberPendingCapture({ path: "/novo.png", target: "t1", kind: "snapshot" }, 999);
    expect(result.dropped?.path).toBe("/c0.png");
    const paths = pendingCapturePaths("t1");
    expect(paths).toHaveLength(MAX_PENDING_CAPTURES);
    expect(paths).not.toContain("/c0.png");
    expect(paths[paths.length - 1]).toBe("/novo.png");
  });

  it("sobrevive a recarregar: a lista volta do armazenamento", async () => {
    const before = await loadModel();
    before.rememberPendingCapture({ path: "/a.png", target: "thread:9", kind: "snapshot" });
    const afterReload = await loadModel();
    expect(afterReload.pendingCapturePaths("thread:9")).toEqual(["/a.png"]);
  });

  it("sem armazenamento disponível, a captura continua valendo nesta sessão", async () => {
    vi.stubGlobal("localStorage", fakeStorage(true));
    const { rememberPendingCapture, pendingCapturePaths } = await loadModel();
    expect(() => rememberPendingCapture({ path: "/a.png", target: "t1", kind: "snapshot" })).not.toThrow();
    expect(pendingCapturePaths("t1")).toEqual(["/a.png"]);
  });
});

describe("forgetPendingCaptures e removedCapturePaths", () => {
  it("tira só os caminhos pedidos e só do alvo informado", async () => {
    const { rememberPendingCapture, forgetPendingCaptures, pendingCapturePaths } = await loadModel();
    rememberPendingCapture({ path: "/a.png", target: "t1", kind: "snapshot" });
    rememberPendingCapture({ path: "/b.png", target: "t1", kind: "snapshot" });
    rememberPendingCapture({ path: "/a.png", target: "t2", kind: "snapshot" });
    forgetPendingCaptures("t1", ["/a.png"]);
    expect(pendingCapturePaths("t1")).toEqual(["/b.png"]);
    expect(pendingCapturePaths("t2")).toEqual(["/a.png"]);
  });

  it("sem alvo, forget não mexe no registro (conversa lateral não tem alvo)", async () => {
    const { rememberPendingCapture, forgetPendingCaptures, pendingCapturePaths } = await loadModel();
    rememberPendingCapture({ path: "/a.png", target: "t1", kind: "snapshot" });
    forgetPendingCaptures(null, ["/a.png"]);
    forgetPendingCaptures(undefined, ["/a.png"]);
    expect(pendingCapturePaths("t1")).toEqual(["/a.png"]);
  });

  it("removedCapturePaths aponta só o que estava no rascunho e saiu", async () => {
    const { removedCapturePaths } = await loadModel();
    expect(removedCapturePaths(["/a.png", "/b.png"], ["/b.png", "/c.png"])).toEqual(["/a.png"]);
    expect(removedCapturePaths([], ["/a.png"])).toEqual([]);
    expect(removedCapturePaths(["/a.png"], [])).toEqual(["/a.png"]);
  });
});

describe("splitRestorableCaptures", () => {
  it("separa o que ainda existe do que falhou na inspeção", async () => {
    const { splitRestorableCaptures } = await loadModel();
    expect(splitRestorableCaptures([
      { path: "/a.png", error: null },
      { path: "/b.png", error: "Não encontrei o arquivo." },
    ])).toEqual({ usable: ["/a.png"], missing: ["/b.png"] });
  });
});
