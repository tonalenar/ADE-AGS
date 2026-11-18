// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatProjectIdentity, setChatProjectIdentity } from "../chatProjectIdentity";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("a identidade do projeto não reanalisa o armazenamento a cada badge", () => {
  it("dez leituras seguidas do mesmo armazenamento fazem um JSON.parse, e a gravação aparece na leitura seguinte", () => {
    setChatProjectIdentity("/p/a", { known: true, name: "Alfa" });
    const parse = vi.spyOn(JSON, "parse");
    for (let i = 0; i < 10; i++) expect(chatProjectIdentity("/p/a").name).toBe("Alfa");
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1);
    setChatProjectIdentity("/p/b", { known: true, name: "Beta" });
    expect(chatProjectIdentity("/p/b").name).toBe("Beta");
    expect(chatProjectIdentity("/p/a").name).toBe("Alfa");
  });
});
