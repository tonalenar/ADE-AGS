import { describe, expect, it } from "vitest";

import {
  asFailure,
  canImport,
  defaultSourceId,
  failureKey,
  keepProfileId,
  listedSources,
  needsKeyPrompt,
  selectAll,
  selectedInOrder,
  sourceStep,
  toggleDomain,
  unavailableKey,
} from "../browserImportModel";
import type { BrowserImportSource } from "../ipc";

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

const fonte = (extra: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "chrome",
  name: "Chrome",
  engine: "chromium",
  profiles: [{ id: "Default", name: "Pessoa" }],
  unavailable: null,
  ...extra,
});

describe("importação do navegador: passos por fonte", () => {
  it("cada motivo leva ao seu passo", () => {
    expect(sourceStep(fonte())).toBe("configure");
    expect(sourceStep(fonte({ profiles: [] }))).toBe("blocked");
    expect(sourceStep(fonte({ unavailable: "browser-running" }))).toBe("quit");
    expect(sourceStep(fonte({ unavailable: "needs-full-disk-access" }))).toBe("fullDiskAccess");
    expect(sourceStep(fonte({ unavailable: "app-bound" }))).toBe("blocked");
    expect(sourceStep(fonte({ unavailable: "not-installed" }))).toBe("blocked");
  });

  it("fonte de outro sistema não entra na lista, e a primeira pronta vira a escolha", () => {
    const lista = listedSources([
      fonte({ id: "safari", unavailable: "unsupported-platform" }),
      fonte({ id: "brave", unavailable: "not-installed", profiles: [] }),
      fonte({ id: "firefox" }),
    ]);
    expect(lista.map((s) => s.id)).toEqual(["brave", "firefox"]);
    expect(defaultSourceId(lista)).toBe("firefox");
    expect(defaultSourceId([fonte({ id: "brave", unavailable: "not-installed", profiles: [] })])).toBe("brave");
    expect(defaultSourceId([])).toBe("");
  });

  it("o perfil de origem se mantém se ainda existe e senão cai no primeiro", () => {
    const duas = fonte({ profiles: [{ id: "Default", name: "A" }, { id: "Profile 1", name: "B" }] });
    expect(keepProfileId(duas, "Profile 1")).toBe("Profile 1");
    expect(keepProfileId(duas, "sumiu")).toBe("Default");
    expect(keepProfileId(undefined, "x")).toBe("");
  });

  it("só o Chromium avisa do pedido do chaveiro", () => {
    expect(needsKeyPrompt(fonte())).toBe(true);
    expect(needsKeyPrompt(fonte({ engine: "safari" }))).toBe(false);
    expect(needsKeyPrompt(fonte({ engine: "firefox" }))).toBe(false);
  });

  it("os códigos novos do backend têm frase, e os desconhecidos caem na genérica", () => {
    for (const code of ["needs-full-disk-access", "needs-keychain-approval", "keychain-item-missing", "keychain-unavailable", "app-bound", "unsupported-platform", "undecryptable", "unknown-source", "invalid-target-profile"]) {
      expect(failureKey(code)).not.toBe("settings.browserImport.error.generic");
    }
    expect(unavailableKey("app-bound")).toBe("settings.browserImport.source.appBound");
    expect(unavailableKey("novo")).toBe("settings.browserImport.error.generic");
  });
});
