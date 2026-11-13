import { describe, expect, it } from "vitest";

import { shownAddress } from "../PhoneChrome";

describe("PhoneChrome", () => {
  it("mostra o domínio sem protocolo nem www", () => {
    expect(shownAddress("https://www.github.com/login?x=1")).toBe("github.com");
    expect(shownAddress("http://localhost:3000/app")).toBe("localhost");
    expect(shownAddress("")).toBe("");
  });
});
