import { describe, expect, it } from "vitest";

/**
 * Constantes e políticas de segurança de Sandbox e CSP para visualização de pranchetas HTML não-confiáveis.
 * O HTML de pranchetas provém de agentes ou usuários e é considerado dado hostil/não-confiável.
 */
export const REQUIRED_SANDBOX_POLICY = "allow-scripts";
export const FORBIDDEN_SANDBOX_TOKEN = "allow-same-origin";

export const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "script-src 'unsafe-inline'",
];

/**
 * Validador estrito de tokens do atributo sandbox de iframe.
 * Garante que 'allow-same-origin' NUNCA esteja presente juntamente com 'allow-scripts'.
 */
export function validateSandboxPolicy(sandboxAttr: string): { isSecure: boolean; violations: string[] } {
  const tokens = sandboxAttr.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const violations: string[] = [];

  if (tokens.includes(FORBIDDEN_SANDBOX_TOKEN)) {
    violations.push(`Violação crítica de sandbox: '${FORBIDDEN_SANDBOX_TOKEN}' é estritamente proibido.`);
  }

  if (!tokens.includes("allow-scripts")) {
    violations.push("Aviso: 'allow-scripts' ausente. Scripts de mockup não rodarão se esperado.");
  }

  return {
    isSecure: violations.length === 0,
    violations,
  };
}

/**
 * Validador estrito da política de segurança de conteúdo (CSP) para pranchetas.
 */
export function validateCspPolicy(cspString: string): { isSecure: boolean; violations: string[] } {
  const violations: string[] = [];
  const normalized = cspString.toLowerCase();

  if (!normalized.includes("default-src 'none'")) {
    violations.push("CSP insegura: deve conter 'default-src \\'none\\'' como base.");
  }

  if (normalized.includes("connect-src") && !normalized.includes("connect-src 'none'")) {
    violations.push("CSP insegura: 'connect-src' externo não é permitido.");
  }

  if (/\bhttps?:\/\//.test(normalized)) {
    violations.push("CSP insegura: URLs externas http/https não são permitidas.");
  }

  if (!normalized.includes("img-src data:")) {
    violations.push("CSP deve permitir apenas imagens inline ('img-src data:').");
  }

  return {
    isSecure: violations.length === 0,
    violations,
  };
}

/**
 * Higienização do cabeçalho HTML: remove tags que tentem sobrescrever CSP ou sequestrar base URL.
 */
export function sanitizeHeadContent(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
}

describe("Testes de Segurança do Sandbox de Design (CSP e Iframe Isolation)", () => {
  describe("Isolamento de Origem do Iframe (Sandbox)", () => {
    it("o sandbox padrão deve conter allow-scripts mas NUNCA allow-same-origin", () => {
      const { isSecure, violations } = validateSandboxPolicy(REQUIRED_SANDBOX_POLICY);
      expect(isSecure).toBe(true);
      expect(violations).toHaveLength(0);
      expect(REQUIRED_SANDBOX_POLICY).not.toContain(FORBIDDEN_SANDBOX_TOKEN);
    });

    it("rejeita veementemente qualquer configuração de sandbox com allow-same-origin", () => {
      const hostileSandboxConfigs = [
        "allow-scripts allow-same-origin",
        "allow-same-origin",
        "allow-forms allow-same-origin allow-scripts",
        "ALLOW-SAME-ORIGIN allow-scripts",
      ];

      for (const config of hostileSandboxConfigs) {
        const result = validateSandboxPolicy(config);
        expect(result.isSecure).toBe(false);
        expect(result.violations.some((v) => v.includes("allow-same-origin"))).toBe(true);
      }
    });
  });

  describe("Validação de Diretivas CSP (Content Security Policy)", () => {
    const defaultCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'";

    it("CSP padrão atende aos requisitos de corte de rede e isolamento", () => {
      const { isSecure, violations } = validateCspPolicy(defaultCsp);
      expect(isSecure).toBe(true);
      expect(violations).toHaveLength(0);
    });

    it("rejeita CSPs permissivas que permitam conexões de rede ou recursos remotos", () => {
      const insecureCsps = [
        "default-src *",
        "default-src 'none'; connect-src https://api.evil.com",
        "default-src 'none'; img-src http://tracker.com",
        "default-src 'none'; script-src https://cdn.jsdelivr.net",
      ];

      for (const csp of insecureCsps) {
        const result = validateCspPolicy(csp);
        expect(result.isSecure).toBe(false);
        expect(result.violations.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Higienização contra Bypasses via <meta> e <base>", () => {
    it("remove meta http-equiv que tente relaxar CSP ou forçar redirecionamento (refresh)", () => {
      const maliciousHtml = `
        <meta http-equiv="refresh" content="0;url=https://attacker.com/steal">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <div>Conteúdo Legítimo</div>
      `;

      const sanitized = sanitizeHeadContent(maliciousHtml);
      expect(sanitized).not.toContain("http-equiv");
      expect(sanitized).not.toContain("refresh");
      expect(sanitized).not.toContain("attacker.com");
      expect(sanitized).toContain("<div>Conteúdo Legítimo</div>");
    });

    it("remove tags <base> que tentem sequestrar caminhos relativos para domínios externos", () => {
      const maliciousBase = `
        <base href="https://evil-server.net/">
        <img src="avatar.png">
      `;

      const sanitized = sanitizeHeadContent(maliciousBase);
      expect(sanitized).not.toContain("<base");
      expect(sanitized).not.toContain("evil-server.net");
      expect(sanitized).toContain('<img src="avatar.png">');
    });
  });
});
