import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { comparar, contar, lex, lintRust, lintTs, modulosDeTeste } from "../../../scripts/test-lint.mjs";

// As fontes de exemplo ficam em strings: o próprio lint apaga strings antes de procurar, então
// este arquivo não acusa a si mesmo.
const regras = (vs: { regra: string; linha: number }[]) => vs.map((v) => `${v.linha}:${v.regra}`);

describe("lint de testes — TypeScript", () => {
  it("acusa espera real com setTimeout e sleep acima do limite", () => {
    const src = [
      "it('a', async () => {",
      "  await new Promise((r) => setTimeout(r, 40));",
      "  await sleep(700);",
      "  setTimeout(() => done(), 120);",
      "});",
    ].join("\n");
    expect(regras(lintTs(src))).toEqual(["2:espera-real", "3:espera-real", "4:espera-real"]);
  });

  it("deixa passar o atraso zero, a definição do helper e o arquivo com fake timers", () => {
    expect(lintTs("await new Promise((r) => setTimeout(r, 0));\nconst sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));")).toEqual([]);
    expect(lintTs("function sleep(ms) { return 1 }\nit('x', () => {})")).toEqual([]);
    expect(lintTs("vi.useFakeTimers();\nsetTimeout(fn, 5000);\nawait sleep(700);")).toEqual([]);
  });

  it("não confunde código dentro de string, template ou JSX com chamada", () => {
    const src = "const a = 'setTimeout(r, 500)';\nconst b = `await sleep(900) it.skip(`;\nconst c = <p>it.skip( don't setTimeout(f, 99)</p>;";
    expect(lintTs(src)).toEqual([]);
  });

  it("acusa polling: laço que dorme, uma vez por laço, mesmo com fake timers", () => {
    const src = [
      "vi.useFakeTimers();",
      "while (!pronto()) {",
      "  for (const x of xs) { await sleep(50); }",
      "}",
      "while (Date.now() < fim) {}",
      "do { await new Promise((r) => setTimeout(r, 25)); } while (!ok);",
    ].join("\n");
    expect(regras(lintTs(src))).toEqual(["3:polling", "5:polling", "6:polling"]);
  });

  it("skip só passa com quarantine na linha ou nas de cima", () => {
    const src = [
      "it.skip('a', () => {});",
      "describe.skip('b', () => {}); // quarantine: #123 instável no CI",
      "// quarantine: depende da rede",
      "it.skip('c', () => {});",
      "xit('d', () => {});",
      "test.skipIf(win)('e', () => {}); // TODO",
      "it.concurrent.skip('f', () => {});",
    ].join("\n");
    expect(regras(lintTs(src))).toEqual(["1:skip-sem-motivo", "5:skip-sem-motivo", "6:skip-sem-motivo", "7:skip-sem-motivo"]);
  });

  it("supressão precisa de motivo", () => {
    const src = [
      "// @ts-ignore",
      "// @ts-expect-error flag global do React para act",
      "/* @ts-expect-error */",
      "// eslint-disable-next-line no-console",
      "// eslint-disable-next-line no-console -- log de diagnóstico do teste",
      "// biome-ignore lint/x: motivo explicado",
      "// biome-ignore lint/x",
    ].join("\n");
    expect(regras(lintTs(src))).toEqual(["1:supressao-sem-motivo", "3:supressao-sem-motivo", "4:supressao-sem-motivo", "7:supressao-sem-motivo"]);
  });
});

describe("lint de testes — Rust", () => {
  it("só olha o código de teste do arquivo", () => {
    const src = [
      "fn produto() { std::thread::sleep(Duration::from_secs(30)); }",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn a() { std::thread::sleep(Duration::from_millis(50)); }",
      "    #[test]",
      "    fn b() { std::thread::sleep(Duration::from_millis(5)); }",
      "}",
    ].join("\n");
    expect(regras(lintRust(src))).toEqual(["5:espera-real"]);
  });

  it("acusa duração não literal, polling e aceita tempo pausado do tokio", () => {
    const src = [
      "fn a() {",
      "    loop {",
      "        if pronto() { break; }",
      "        std::thread::sleep(POLL);",
      "    }",
      "}",
      "impl Drop for X { fn drop(&mut self) { std::thread::sleep(Duration::from_millis(1)); } }",
    ].join("\n");
    expect(regras(lintRust(src, { todoArquivo: true }))).toEqual(["2:polling", "4:espera-real"]);
    const pausado = "#[tokio::test(start_paused = true)]\nasync fn a() { tokio::time::sleep(Duration::from_secs(9)).await; }";
    expect(lintRust(pausado, { todoArquivo: true })).toEqual([]);
  });

  it("#[ignore] passa com motivo nativo ou quarantine; #[allow] com comentário ou reason", () => {
    const src = [
      "#[ignore]",
      "fn a() {}",
      "#[ignore = \"usa a rede\"]",
      "fn b() {}",
      "#[ignore] // quarantine: #77 trava no Windows",
      "fn c() {}",
      "#[allow(dead_code)]",
      "fn d() {}",
      "// Só o teste do Windows usa.",
      "#[allow(dead_code)]",
      "fn e() {}",
      "#[allow(dead_code, reason = \"helper de outro teste\")]",
      "fn f() {}",
      "let s = \"#[ignore] std::thread::sleep(Duration::from_secs(9))\";",
      "let c = '{';",
    ].join("\n");
    expect(regras(lintRust(src, { todoArquivo: true }))).toEqual(["1:skip-sem-motivo", "7:supressao-sem-motivo"]);
  });

  it("lexer: raw string, comentário aninhado e char de chave não quebram as posições", () => {
    const src = "let a = r#\"x \" { \"#; /* a /* b */ c */ let b = '}';\nfn z() {}";
    const { code, comments } = lex(src, "rs");
    expect(code.length).toBe(src.length);
    expect(code).not.toContain("x \"");
    expect(code.split("{").length).toBe(code.split("}").length);
    expect(comments[0]).toContain("/* a /* b */ c */");
  });

  it("acha os módulos de teste declarados com #[cfg(test)] e #[path]", () => {
    const dir = join("raiz", "src", "accounts");
    const src = "mod store;\n#[cfg(test)]\nmod test;\n#[cfg(test)]\n#[path = \"../cli_test.rs\"]\nmod cli;\n#[cfg(not(test))]\nmod real;";
    const found = modulosDeTeste(src, join(dir, "mod.rs"));
    expect(found).toEqual([join(dir, "test", "mod.rs"), join("raiz", "src", "cli_test.rs")].map((p) => expect.stringContaining(p)));
    expect(modulosDeTeste(src, join(dir, "mod.rs"), { todos: true })).toHaveLength(4);
  });
});

describe("baseline", () => {
  it("falha só quando a contagem passa do baseline e avisa quando pode encolher", () => {
    const atual = contar([
      { arquivo: "a.test.ts", regra: "espera-real" },
      { arquivo: "a.test.ts", regra: "espera-real" },
      { arquivo: "b.rs", regra: "polling" },
    ]);
    expect(atual).toEqual({ "a.test.ts": { "espera-real": 2 }, "b.rs": { polling: 1 } });
    const { novas, encolheu } = comparar(atual, { "a.test.ts": { "espera-real": 2 }, "c.rs": { "skip-sem-motivo": 1 } });
    expect(novas).toEqual([{ arquivo: "b.rs", regra: "polling", antes: 0, agora: 1 }]);
    expect(encolheu).toEqual([{ arquivo: "c.rs", regra: "skip-sem-motivo", antes: 1, agora: 0 }]);
    expect(comparar(atual, atual)).toEqual({ novas: [], encolheu: [] });
  });
});
