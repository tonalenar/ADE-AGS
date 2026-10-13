import { describe, expect, it } from "vitest";

import { accountNameLooksValid, clientIdLooksValid, clientSecretLooksValid, isGoogleAuthUrl, maskClientId } from "../oauthModel";

describe("OAuth próprio do Antigravity", () => {
  it("o id do cliente tem o formato do Google, igual ao backend", () => {
    expect(clientIdLooksValid("123-abc_DEF.apps.googleusercontent.com")).toBe(true);
    expect(clientIdLooksValid("  123-abc.apps.googleusercontent.com  ")).toBe(true);
    expect(clientIdLooksValid("123-abc.example.com")).toBe(false);
    expect(clientIdLooksValid("a b.apps.googleusercontent.com")).toBe(false);
    expect(clientIdLooksValid("")).toBe(false);
  });

  it("o segredo e o nome recusam vazio, controle e tamanho demais", () => {
    expect(clientSecretLooksValid("GOCSPX-abc")).toBe(true);
    expect(clientSecretLooksValid("")).toBe(false);
    expect(clientSecretLooksValid("a\nb")).toBe(false);
    expect(clientSecretLooksValid("x".repeat(513))).toBe(false);
    expect(accountNameLooksValid(" Pessoal ")).toBe(true);
    expect(accountNameLooksValid("   ")).toBe(false);
    expect(accountNameLooksValid("a\u0007b")).toBe(false);
    expect(accountNameLooksValid("x".repeat(101))).toBe(false);
  });

  it("mostra só o começo e o fim do id", () => {
    expect(maskClientId("1234567890-abcdefghij.apps.googleusercontent.com")).toBe("12345678…ghij.apps.googleusercontent.com");
    expect(maskClientId("curto.apps.googleusercontent.com")).toBe("curto.apps.googleusercontent.com");
  });

  it("só abre no navegador um https do Google", () => {
    expect(isGoogleAuthUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(true);
    expect(isGoogleAuthUrl("http://accounts.google.com/o/oauth2/v2/auth")).toBe(false);
    expect(isGoogleAuthUrl("https://accounts.google.com.evil.example/auth")).toBe(false);
    expect(isGoogleAuthUrl("javascript:alert(1)")).toBe(false);
    expect(isGoogleAuthUrl("não é url")).toBe(false);
  });
});
