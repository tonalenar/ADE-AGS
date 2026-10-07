import { describe, expect, it } from "vitest";
import { needsSecretConfirmation } from "../secretConfirm";

describe("confirmação de credencial", () => {
  it("reconhece o código estável do backend em string ou erro", () => {
    expect(needsSecretConfirmation("CONFIRMACAO_DE_CREDENCIAL: reescreva ou confirme")).toBe(true);
    expect(needsSecretConfirmation(new Error("CONFIRMACAO_DE_CREDENCIAL: na aprovação"))).toBe(true);
    expect(needsSecretConfirmation({ message: "CONFIRMACAO_DE_CREDENCIAL" })).toBe(true);
  });

  it("não trata política de senha nem erro comum como confirmação", () => {
    expect(needsSecretConfirmation("senha: mínimo 12 caracteres")).toBe(false);
    expect(needsSecretConfirmation("memory cannot contain credentials")).toBe(false);
    expect(needsSecretConfirmation(new Error("workspace is unavailable"))).toBe(false);
  });
});
