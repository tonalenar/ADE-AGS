import { describe, expect, it } from "vitest";

import { isLocalOrigin } from "../localOrigin";
import { isLocalUrl, normalizeUrl } from "../viewTabs";

describe("isLocalOrigin", () => {
  it("aceita loopback e nomes .local/.localhost", () => {
    expect(isLocalOrigin("localhost")).toBe(true);
    expect(isLocalOrigin("127.0.0.1")).toBe(true);
    expect(isLocalOrigin("127.255.255.255")).toBe(true);
    expect(isLocalOrigin("::1")).toBe(true);
    expect(isLocalOrigin("[::1]")).toBe(true);
    expect(isLocalOrigin("app.localhost")).toBe(true);
    expect(isLocalOrigin("mi-app.local")).toBe(true);
  });

  it("não trata 0.0.0.0 nem redes alheias como locais", () => {
    expect(isLocalOrigin("0.0.0.0")).toBe(false);
    expect(isLocalOrigin("8.8.8.8")).toBe(false);
    expect(isLocalOrigin("example.com")).toBe(false);
  });
});

describe("normalizeUrl / isLocalUrl usam a mesma regra", () => {
  it("0.0.0.0 não vira http local", () => {
    expect(normalizeUrl("0.0.0.0:8080")).toBe("https://0.0.0.0:8080");
    expect(isLocalUrl("http://0.0.0.0:8080")).toBe(false);
  });
});
