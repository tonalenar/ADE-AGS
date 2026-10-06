import { describe, expect, it } from "vitest";

import { bothIsSafe, conflictCount, parseConflicts, resolveConflicts } from "../conflicts";

const md = [
  "# Roadmap",
  "<<<<<<< HEAD",
  "- [x] item A",
  "- comum",
  "=======",
  "- comum",
  "- [x] item B",
  ">>>>>>> origin/master",
  "fim",
  "",
].join("\n");

describe("parseConflicts", () => {
  it("separa texto e blocos com os dois lados e as etiquetas", () => {
    const p = parseConflicts(md);
    expect(conflictCount(p)).toBe(1);
    const c = p.segments.find((s) => s.kind === "conflict")!;
    expect(c.kind === "conflict" && c.ours).toEqual(["- [x] item A", "- comum"]);
    expect(c.kind === "conflict" && c.theirs).toEqual(["- comum", "- [x] item B"]);
    expect(c.kind === "conflict" && c.theirsLabel).toBe("origin/master");
  });

  it("lê a base do estilo diff3", () => {
    const p = parseConflicts("<<<<<<< a\nx\n||||||| base\nb\n=======\ny\n>>>>>>> c\n");
    const c = p.segments[0]!;
    expect(c.kind === "conflict" && c.base).toEqual(["b"]);
  });

  it("um bloco sem fechar é malformado e não se resolve", () => {
    expect(parseConflicts("<<<<<<< a\nx\n=======\ny\n").malformed).toBe(true);
    expect(resolveConflicts("a.md", "<<<<<<< a\nx\n", "both")).toBeNull();
  });
});

describe("resolveConflicts", () => {
  it("ours / theirs ficam com um lado só", () => {
    expect(resolveConflicts("R.md", md, "ours")!.content).toBe("# Roadmap\n- [x] item A\n- comum\nfim\n");
    expect(resolveConflicts("R.md", md, "theirs")!.content).toBe("# Roadmap\n- comum\n- [x] item B\nfim\n");
  });

  it("both mantém os dois sem repetir a linha idêntica", () => {
    expect(resolveConflicts("R.md", md, "both")!.content).toBe("# Roadmap\n- [x] item A\n- comum\n- [x] item B\nfim\n");
  });

  it("respeita CRLF", () => {
    const r = resolveConflicts("R.md", md.replace(/\n/g, "\r\n"), "both")!;
    expect(r.content).toBe("# Roadmap\r\n- [x] item A\r\n- comum\r\n- [x] item B\r\nfim\r\n");
  });

  it("uma escolha por bloco", () => {
    const two = `${md}${md}`;
    const r = resolveConflicts("R.md", two, "both", { 1: "theirs" })!;
    expect(r.content).toContain("- [x] item A");
    expect(r.content.split("- [x] item A").length - 1).toBe(1);
  });

  it("locale JSON: both acrescenta as chaves dos dois lados e continua sendo JSON válido", () => {
    const json = ['{', '  "a": "1",', '<<<<<<< HEAD', '  "mine": "x"', '=======', '  "theirs": "y"', '>>>>>>> origin/master', '}', ''].join("\n");
    const r = resolveConflicts("src/i18n/locales/en.json", json, "both")!;
    expect(r.valid).toBe(true);
    expect(JSON.parse(r.content)).toEqual({ a: "1", mine: "x", theirs: "y" });
  });

  it("locale JSON: com mais chaves depois do bloco, a última mantém a vírgula", () => {
    const json = ['{', '<<<<<<< HEAD', '  "m": "x",', '=======', '  "t": "y"', '>>>>>>> o', '  "z": "3"', '}'].join("\n");
    const r = resolveConflicts("a.json", json, "both")!;
    expect(r.valid).toBe(true);
    expect(JSON.parse(r.content)).toEqual({ m: "x", t: "y", z: "3" });
  });

  it("JSON inválido após a fusão é sinalizado", () => {
    const json = ['{', '<<<<<<< HEAD', '  "k": "a"', '=======', '  "k": "b",', '>>>>>>> o', '}'].join("\n");
    expect(resolveConflicts("a.json", json, "theirs")!.valid).toBe(false);
  });
});

describe("bothIsSafe", () => {
  it("só docs e locales aceitam manter os dois", () => {
    expect(bothIsSafe("docs/ade-ags/ROADMAP.md")).toBe(true);
    expect(bothIsSafe("src/i18n/locales/es.json")).toBe(true);
    expect(bothIsSafe("src/main.rs")).toBe(false);
  });
});
