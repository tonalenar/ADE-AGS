import { describe, expect, it } from "vitest";

import { meterTone } from "@/features/accounts/meter";

describe("meterTone (barra de cota das contas)", () => {
  it("destaque até 59%, âmbar de 60% a 79%, vermelha de 80% em diante", () => {
    expect(meterTone(0)).toBe("bg-accent-600");
    expect(meterTone(59)).toBe("bg-accent-600");
    expect(meterTone(60)).toBe("bg-amber-500");
    expect(meterTone(79)).toBe("bg-amber-500");
    expect(meterTone(80)).toBe("bg-red-500");
    expect(meterTone(130)).toBe("bg-red-500");
  });
});
