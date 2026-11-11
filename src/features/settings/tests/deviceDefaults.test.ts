import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CHAT_PREFS, loadChatPrefs, saveChatPrefs } from "@/features/chat/chatPrefs";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { TERMINAL_ZOOM } from "@/features/terminal/theme";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { readAppearanceMode } from "@/features/settings/appearanceMode";
import { DEVICE_DEFAULTS } from "@/features/settings/deviceDefaults";
import {
  changedDeviceDefaults,
  restoreDeviceDefaults,
  sameSettingValue,
  type DeviceDefault,
} from "@/features/settings/deviceDefaultsModel";
import { readMotionDuration } from "@/features/settings/motionPreferences";

// O IPC do banco não existe nos testes: as leituras voltam vazias, e as gravações ficam registradas.
vi.mock("@/shared/ipc/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

const catalog: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../i18n/locales/pt-BR.json", import.meta.url)), "utf8"),
);

/** Um armazenamento de mentira: o `localStorage` de um navegador, guardado num `Map`. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) ?? null) : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

const idsOf = (items: readonly DeviceDefault[]) => items.map((item) => item.id);

describe("modelo da restauração (sem armazenamento)", () => {
  it("só entra quem está fora do padrão, na ordem do registro", async () => {
    const items: DeviceDefault[] = [
      { id: "a", labelKey: "k", changed: () => true, restore: () => undefined },
      { id: "b", labelKey: "k", changed: () => false, restore: () => undefined },
      { id: "c", labelKey: "k", changed: async () => true, restore: () => undefined },
    ];
    expect(idsOf(await changedDeviceDefaults(items))).toEqual(["a", "c"]);
  });

  it("um ajuste que não se consegue ler fica de fora, sem parar os outros", async () => {
    const items: DeviceDefault[] = [
      { id: "ilegivel", labelKey: "k", changed: () => { throw new Error("armazenamento bloqueado"); }, restore: () => undefined },
      { id: "ok", labelKey: "k", changed: () => true, restore: () => undefined },
    ];
    expect(idsOf(await changedDeviceDefaults(items))).toEqual(["ok"]);
  });

  it("restaura só o que recebeu, na ordem; um erro não impede os seguintes", async () => {
    const calls: string[] = [];
    const items: DeviceDefault[] = [
      { id: "a", labelKey: "k", changed: () => true, restore: () => { calls.push("a"); } },
      { id: "b", labelKey: "k", changed: () => true, restore: () => { calls.push("b"); throw new Error("falhou"); } },
      { id: "c", labelKey: "k", changed: () => true, restore: async () => { calls.push("c"); } },
    ];
    const outcome = await restoreDeviceDefaults(items, { setTheme: () => undefined });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(idsOf(outcome.restored)).toEqual(["a", "c"]);
    expect(idsOf(outcome.failed)).toEqual(["b"]);
  });

  it("sem nada fora do padrão, não restaura nada", async () => {
    const outcome = await restoreDeviceDefaults([], { setTheme: () => undefined });
    expect(outcome.restored).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });

  it("compara valores pelo conteúdo: a ordem das chaves não importa, a dos itens de lista importa", () => {
    expect(sameSettingValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameSettingValue([1, 2], [2, 1])).toBe(false);
    expect(sameSettingValue({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("ajustes do aparelho (registro)", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.mocked(getSetting).mockImplementation(async () => null);
    vi.mocked(setSetting).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useTerminalPrefsStore.getState().setZoom(TERMINAL_ZOOM.default);
    useTerminalPrefsStore.getState().setInputMarks(true);
  });

  it("cada ajuste tem id único e um nome no catálogo pt-BR", () => {
    const ids = DEVICE_DEFAULTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of DEVICE_DEFAULTS) expect(catalog[item.labelKey], item.id).toBeTypeOf("string");
  });

  it("sem nenhuma preferência gravada, nada está fora do padrão", async () => {
    expect(await changedDeviceDefaults(DEVICE_DEFAULTS)).toEqual([]);
  });

  it("aparência e animações voltam ao padrão, e o tema é reaplicado na janela", async () => {
    storage.setItem("ade-appearance-mode", "light");
    storage.setItem("cc-motion-duration-ms", "250");
    const changed = await changedDeviceDefaults(DEVICE_DEFAULTS);
    expect(idsOf(changed)).toEqual(expect.arrayContaining(["appearance", "motion"]));

    const setTheme = vi.fn();
    await restoreDeviceDefaults(changed.filter((item) => item.id === "appearance" || item.id === "motion"), { setTheme });

    expect(readAppearanceMode()).toBe("dark");
    expect(readMotionDuration()).toBe(170);
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(idsOf(await changedDeviceDefaults(DEVICE_DEFAULTS))).not.toContain("appearance");
  });

  it("notificações voltam a ligadas pelo banco do app", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === "notifications.enabled" ? "false" : null));
    const changed = await changedDeviceDefaults(DEVICE_DEFAULTS);
    expect(idsOf(changed)).toContain("notifications");

    await restoreDeviceDefaults(changed.filter((item) => item.id === "notifications"), { setTheme: () => undefined });
    expect(setSetting).toHaveBeenCalledWith("notifications.enabled", "true");
  });

  it("o comportamento da conversa volta ao padrão, mas a última escolha do composer fica como está (como o T3)", async () => {
    saveChatPrefs({
      ...DEFAULT_CHAT_PREFS,
      width: "wide",
      followUpBehavior: "queue",
      cwd: "/projetos/x",
      agentId: "codex",
      model: "gpt-x",
      effort: "high",
      access: "full",
    });
    const changed = await changedDeviceDefaults(DEVICE_DEFAULTS);
    expect(idsOf(changed)).toContain("chat");

    await restoreDeviceDefaults(changed.filter((item) => item.id === "chat"), { setTheme: () => undefined });
    const after = loadChatPrefs();
    expect(after.width).toBe(DEFAULT_CHAT_PREFS.width);
    expect(after.followUpBehavior).toBe(DEFAULT_CHAT_PREFS.followUpBehavior);
    // Escolhas do composer: o modelo, o agente, o esforço e a permissão continuam os mesmos.
    expect(after.cwd).toBe("/projetos/x");
    expect(after.agentId).toBe("codex");
    expect(after.model).toBe("gpt-x");
    expect(after.effort).toBe("high");
    expect(after.access).toBe("full");
  });

  it("o texto e as marcas do terminal voltam ao padrão", async () => {
    useTerminalPrefsStore.getState().setZoom(150);
    useTerminalPrefsStore.getState().setInputMarks(false);
    const changed = await changedDeviceDefaults(DEVICE_DEFAULTS);
    expect(idsOf(changed)).toContain("terminal");

    await restoreDeviceDefaults(changed.filter((item) => item.id === "terminal"), { setTheme: () => undefined });
    expect(useTerminalPrefsStore.getState().zoom).toBe(TERMINAL_ZOOM.default);
    expect(useTerminalPrefsStore.getState().inputMarks).toBe(true);
  });

  it("não mexe em sandbox, contas nem chaves, mesmo com o restaurar completo", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === "runs.sandbox" ? "strict" : key === "notifications.enabled" ? "false" : null));
    const changed = await changedDeviceDefaults(DEVICE_DEFAULTS);
    await restoreDeviceDefaults(changed, { setTheme: () => undefined });
    const keysWritten = vi.mocked(setSetting).mock.calls.map(([key]) => key);
    expect(keysWritten).not.toContain("runs.sandbox");
    expect(keysWritten.every((key) => key === "notifications.enabled")).toBe(true);
  });
});
