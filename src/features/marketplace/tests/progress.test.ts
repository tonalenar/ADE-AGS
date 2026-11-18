import { describe, expect, it } from "vitest";

import { registryProgressWarning } from "../progress";
import type { RegistryProgress } from "../types";

describe("registryProgressWarning", () => {
  it("retém e traduz o aviso parcial no evento final", () => {
    const progress: RegistryProgress = {
      registryId: "r1", phase: "done", current: 2, total: 3, detail: "uma falha",
    };
    expect(registryProgressWarning(progress)).toBe("uma falha");
  });

  it("não mostra aviso no resultado completo", () => {
    expect(registryProgressWarning({
      registryId: "r1", phase: "done", current: 3, total: 3, detail: null,
    })).toBeNull();
  });
});
