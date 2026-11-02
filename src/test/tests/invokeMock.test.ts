import { describe, expect, it } from "vitest";

import { createInvokeMock } from "../invokeMock";

describe("invokeMock", () => {
  it("responde por nome: once em ordem antes do on, com valor ou função dos argumentos", async () => {
    const m = createInvokeMock();
    m.on("soma", ({ a, b }) => (a as number) + (b as number)).once("soma", 100).once("soma", async () => 200);
    expect(await m.invoke("soma", { a: 1, b: 2 })).toBe(100);
    expect(await m.invoke("soma", { a: 1, b: 2 })).toBe(200);
    expect(await m.invoke("soma", { a: 1, b: 2 })).toBe(3);
    expect(m.calls("soma")).toHaveLength(3);
    expect(m.commands()).toEqual(["soma", "soma", "soma"]);
    m.assertNoUnmatched();
  });

  it("a resposta que lança vira a rejeição do invoke, como o erro do backend", async () => {
    const m = createInvokeMock();
    m.on("falha", () => { throw { kind: "api", message: "não deu" }; });
    await expect(m.invoke("falha")).rejects.toEqual({ kind: "api", message: "não deu" });
    m.assertNoUnmatched();
  });

  it("a chamada sem resposta rejeita e reprova no teardown, mesmo que o código engula o erro", async () => {
    const m = createInvokeMock();
    await m.invoke("sumiu", { id: 7 }).catch(() => undefined);
    expect(() => m.assertNoUnmatched()).toThrow(/chamado sem resposta: sumiu \{"id":7\}/);
  });

  it("a resposta once que ninguém pediu também reprova", () => {
    const m = createInvokeMock();
    m.once("esperado", 1);
    expect(() => m.assertNoUnmatched()).toThrow(/preparado e nunca chamado: esperado/);
    m.reset();
    expect(() => m.assertNoUnmatched()).not.toThrow();
  });
});
