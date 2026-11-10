import { describe, expect, it } from "vitest";

import { asFailure, canImport, failureKey, selectAll, selectedInOrder, toggleDomain } from "../browserImportModel";

const revisao = [
  { domain: "github.com", cookies: 3 },
  { domain: "google.com", cookies: 1 },
  { domain: "npmjs.org", cookies: 2 },
];

describe("importação do navegador: marcar domínios", () => {
  it("marcar acrescenta e marcar de novo tira, sem mudar o conjunto recebido", () => {
    const antes = new Set(["github.com"]);
    const depois = toggleDomain(antes, "google.com");
    expect([...depois].sort()).toEqual(["github.com", "google.com"]);
    expect([...antes]).toEqual(["github.com"]);
    expect([...toggleDomain(depois, "github.com")]).toEqual(["google.com"]);
  });

  it("só entram os domínios marcados, na ordem em que a revisão os mostra", () => {
    expect(selectedInOrder(revisao, new Set(["npmjs.org", "github.com"]))).toEqual(["github.com", "npmjs.org"]);
  });

  it("marcar todos seleciona a revisão inteira, na ordem dela", () => {
    expect(selectedInOrder(revisao, selectAll(revisao))).toEqual(["github.com", "google.com", "npmjs.org"]);
  });

  it("sem nenhum domínio marcado, a importação não pode começar", () => {
    expect(canImport(new Set())).toBe(false);
    expect(canImport(new Set(["github.com"]))).toBe(true);
  });
});

describe("importação do navegador: recusas", () => {
  it("cada código do backend tem a sua frase", () => {
    expect(failureKey("browser-running")).toBe("settings.browserImport.error.browserRunning");
    expect(failureKey("no-state-key")).toBe("settings.browserImport.error.noStateKey");
  });

  it("um código desconhecido cai na frase genérica, inclusive nomes que o objeto já tem", () => {
    expect(failureKey("codigo-novo")).toBe("settings.browserImport.error.generic");
    expect(failureKey("constructor")).toBe("settings.browserImport.error.generic");
  });

  it("uma recusa vira código e detalhe; qualquer outra coisa vira a genérica", () => {
    expect(asFailure({ code: "lock-unknown", detail: "sem permissão" })).toEqual({ code: "lock-unknown", detail: "sem permissão" });
    expect(asFailure({ code: "no-profile" })).toEqual({ code: "no-profile", detail: null });
    expect(asFailure("erro solto")).toEqual({ code: "generic", detail: null });
    expect(asFailure(null)).toEqual({ code: "generic", detail: null });
  });
});
