import { describe, expect, it } from "vitest";

import { conferir, hashDoAlvo, nomeDoRegistro, normalizarRust, validarRegistro } from "../../../scripts/fingerprint.mjs";

const registro = (sobre: Record<string, unknown> = {}) => ({
  alvo: "schema-sqlite",
  sha256: "a".repeat(64),
  data: "2026-11-02",
  motivo: "coluna nova, aditiva",
  semPerdaDeDados: true,
  ...sobre,
});

describe("fingerprint — normalização do fonte Rust", () => {
  it("ignora comentários, reindentação e CRLF", () => {
    const a = 'const V: i32 = 45; // versão\nfn m() {\n    exec("ALTER TABLE t ADD COLUMN c")\n}';
    const b = '/* bloco /* aninhado */ */ const V: i32 = 45;\r\nfn m() { exec("ALTER TABLE t ADD COLUMN c") }';
    expect(normalizarRust(a)).toBe(normalizarRust(b));
  });

  it("muda quando o SQL de uma string muda, inclusive com // ou /* dentro dela", () => {
    const base = 'exec("CREATE TABLE t (url TEXT DEFAULT \'http://x\')")';
    expect(normalizarRust(base)).toContain("http://x");
    expect(normalizarRust(base)).not.toBe(normalizarRust(base.replace("TEXT", "INTEGER")));
    expect(normalizarRust('r#"a // b /* c"#')).toBe('r#"a // b /* c"#');
  });

  it("não confunde lifetime com literal de caractere", () => {
    expect(normalizarRust("fn f<'a>(x: &'a str) -> char { '/' }")).toBe("fn f<'a>(x: &'a str) -> char { '/' }");
  });

  it("o hash do alvo depende do conteúdo normalizado", () => {
    const um = hashDoAlvo("protocolo-ipc", () => "pub struct R { a: u8 } // x");
    expect(hashDoAlvo("protocolo-ipc", () => "pub struct R {\n  a: u8\n}")).toBe(um);
    expect(hashDoAlvo("protocolo-ipc", () => "pub struct R { a: u16 }")).not.toBe(um);
  });
});

describe("fingerprint — registros de reconhecimento", () => {
  it("passa só quando há registro válido com o hash atual de cada alvo", () => {
    const atuais = { "schema-sqlite": "a".repeat(64), "protocolo-ipc": "b".repeat(64) };
    const reg = registro();
    const ok = conferir(atuais, [{ nome: nomeDoRegistro(reg.alvo, reg.sha256), reg }]);
    expect(ok.invalidos).toEqual([]);
    expect(ok.pendentes).toEqual([{ alvo: "protocolo-ipc", sha: "b".repeat(64) }]);
  });

  it("schema sem a afirmação de que não apaga dados é recusado", () => {
    expect(validarRegistro(registro({ semPerdaDeDados: false }))).toEqual([
      expect.stringContaining("semPerdaDeDados"),
    ]);
    expect(validarRegistro(registro({ alvo: "protocolo-ipc", semPerdaDeDados: undefined }))).toEqual([]);
  });

  it("recusa motivo vazio, data malformada e arquivo com nome que não bate com o hash", () => {
    const erros = validarRegistro(registro({ motivo: "x", data: "02/11/2026" }), "schema-sqlite-000000000000.json");
    expect(erros).toHaveLength(3);
  });

  it("um registro inválido não conta como reconhecimento", () => {
    const reg = registro({ motivo: "" });
    const { pendentes, invalidos } = conferir({ "schema-sqlite": reg.sha256 as string }, [{ nome: "x.json", reg }]);
    expect(invalidos).toHaveLength(1);
    expect(pendentes).toHaveLength(1);
  });
});
