import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { ChatMarkdown, safeHref, textOf } from "../ChatMarkdown";

const html = (text: string) => renderToStaticMarkup(<ChatMarkdown text={text} />);

describe("safeHref", () => {
  it("deja pasar solo http/https", () => {
    expect(safeHref("https://a.com/x")).toBe("https://a.com/x");
    expect(safeHref("http://a.com")).toBe("http://a.com/");
    for (const bad of ["javascript:alert(1)", "file:///c:/x", "data:text/html,hi", "tauri://x", "/rel", "", "  JaVaScRiPt:1"]) expect(safeHref(bad)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });
});

describe("ChatMarkdown", () => {
  it("renderiza titulos, listas, negrita, codigo, tablas y citas", () => {
    const out = html("# T\n\n- a\n- **b**\n\n`x`\n\n> cita\n\n| h |\n|---|\n| c |");
    expect(out).toContain("<h1");
    expect(out).toContain("<li>");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<code");
    expect(out).toContain("<blockquote");
    expect(out).toContain("<table");
  });
  it("bloque de codigo con boton copiar y rolagem", () => {
    const out = html("```ts\nconst a = 1;\n```");
    expect(out).toContain("canvas.chat.copyCode");
    expect(out).toContain("overflow-auto");
    expect(out).toContain("const a = 1;");
  });
  it("no emite HTML crudo", () => {
    const out = html("<script>alert(1)</script><img src=x onerror=alert(1)><b>hola</b>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<img");
  });
  it("enlaces peligrosos no son <a>", () => {
    expect(html("[x](javascript:alert(1))")).not.toContain("<a ");
    expect(html("[ok](https://a.com)")).toContain('href="https://a.com/"');
  });
  it("las imagenes no se cargan", () => {
    expect(html("![logo](https://tracker.com/p.png)")).not.toContain("<img");
  });
});

describe("textOf", () => {
  it("aplana el arbol", () => {
    expect(textOf(["a", 1, null, <b key="k">c</b>])).toBe("a1c");
  });
});
