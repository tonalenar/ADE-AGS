import { describe, expect, it } from "vitest";

import { mascotStateFor } from "../Mascot";

describe("mascotStateFor", () => {
  it("sem nada na frota fica em repouso", () => {
    expect(mascotStateFor({ running: 0, needsYou: 0 })).toBe("idle");
  });

  it("com agentes rodando trabalha", () => {
    expect(mascotStateFor({ running: 2, needsYou: 0 })).toBe("working");
  });

  /// Esperando você pede uma ação; trabalhando, não. Por isso ganha mesmo com outros rodando.
  it("alguém esperando você vence quem está rodando", () => {
    expect(mascotStateFor({ running: 3, needsYou: 1 })).toBe("waiting");
  });
});
