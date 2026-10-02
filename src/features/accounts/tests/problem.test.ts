import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import ptBR from "@/i18n/locales/pt-BR.json";
import { accountProblemKey, accountProblemText } from "../problem";

describe("account problems", () => {
  it("translates the Spanish warning from an older backend into Portuguese", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: ptBR } } });
    expect(accountProblemText("La TUI no mostró el panel de consumo a tiempo", i18n.t.bind(i18n)))
      .toBe("O Claude não exibiu o painel de consumo a tempo. Tente atualizar ou faça login novamente.");
    expect(accountProblemText("accounts.plan.problem.timeout", i18n.t.bind(i18n)))
      .toBe(accountProblemText("La TUI no mostró el panel de consumo a tiempo", i18n.t.bind(i18n)));
  });

  it("recognizes an expired OAuth session in saved task errors", () => {
    expect(accountProblemKey("Failed to authenticate: OAuth session expired and could not be refreshed"))
      .toBe("accounts.auth.expired");
    expect(accountProblemKey("Not logged in · Please run /login")).toBe("accounts.auth.required");
  });

  it("preserves unknown diagnostics and provides a translated fallback", () => {
    expect(accountProblemText("Connection reset by peer", (key) => key)).toBe("Connection reset by peer");
    expect(accountProblemText(null, (key) => `translated:${key}`)).toBe("translated:accounts.plan.failed");
    expect(accountProblemKey("accounts.plan.problem.unknown")).toBeNull();
  });
});
