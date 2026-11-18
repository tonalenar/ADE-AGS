import { afterEach, describe, expect, it, vi } from "vitest";

const sessionTitle = vi.fn();
vi.mock("../ipc", () => ({ sessionTitle: (...args: unknown[]) => sessionTitle(...args) }));

import { TITLE_REFRESH_MS, refreshSessionTitle } from "../sessionTitle";
import type { Tab } from "@/features/tabs/types";

const tab = { id: "t1", title: "Claude", titleIsCustom: false, agentId: "claude-code", cwd: "/tmp", sessionId: "s" } as Tab;

describe("título ao fechar a aba", () => {
  afterEach(() => vi.useRealTimers());

  it("não espera a consulta para sempre: devolve o título atual no limite", async () => {
    vi.useFakeTimers();
    sessionTitle.mockReturnValue(new Promise(() => {}));
    const pending = refreshSessionTitle(tab);
    await vi.advanceTimersByTimeAsync(TITLE_REFRESH_MS);
    await expect(pending).resolves.toBe("Claude");
  });
});
