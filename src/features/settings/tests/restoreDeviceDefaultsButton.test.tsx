/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";

import { shouldToastRestoreRead } from "../restoreReadToast";
import { uiErrorText } from "@/shared/uiErrorText";

describe("RestoreDeviceDefaultsButton (regras extraídas)", () => {
  it("com a leitura falhando, focus/storage/tema não repetem o toast", () => {
    expect(shouldToastRestoreRead("refresh", false)).toBe(true);
    expect(shouldToastRestoreRead("refresh", true)).toBe(false);
  });

  it("no restore, o toast usa a mensagem do erro e não [object Object]", () => {
    expect(shouldToastRestoreRead("restore", true)).toBe(true);
    expect(uiErrorText({ message: "sem armazenamento" })).toBe("sem armazenamento");
    expect(uiErrorText({ message: "sem armazenamento" })).not.toContain("[object Object]");
  });
});
