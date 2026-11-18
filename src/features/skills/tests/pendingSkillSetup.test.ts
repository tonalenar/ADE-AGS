import { afterEach, describe, expect, it } from "vitest";

import { awaitSkillSetup, registerPendingSkillSetup } from "../pendingSkillSetup";

describe("registerPendingSkillSetup", () => {
  const onUnhandled = (reason: unknown) => {
    throw new Error(`rejeição sem tratamento: ${String(reason)}`);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("não deixa rejeição órfã quando o setup falha", async () => {
    process.on("unhandledRejection", onUnhandled);
    let rejectSetup!: (error: Error) => void;
    const setup = new Promise<string[]>((_, reject) => { rejectSetup = reject; });
    registerPendingSkillSetup("tab-1", setup);
    const waiting = awaitSkillSetup("tab-1");
    rejectSetup(new Error("montar"));
    await expect(waiting).resolves.toEqual(["Error: montar"]);
    await Promise.resolve();
    await Promise.resolve();
  });
});
