// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  followAppBoot,
  splashDismiss,
  splashFinish,
  splashReached,
  splashStep,
  SPLASH_AGENTS_CAP_MS,
  SPLASH_LEAVE_MS,
  SPLASH_WAVE_MS,
} from "@/app/splash";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INDEX = readFileSync(path.join(ROOT, "index.html"), "utf8");

/** O corpo do `index.html` de verdade, com os textos que o script inline poria. */
function mountSplash() {
  // Sem os <script>: o happy-dom tentaria rodá-los (e baixar o `main.tsx`).
  const body = INDEX.slice(INDEX.indexOf("<body>") + 6, INDEX.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;
  const texts = ["Abrindo a janela", "Carregando os workspaces", "Religando os terminais", "Conectando os agentes"];
  document.querySelectorAll<HTMLElement>("#ags-splash-steps li").forEach((li, i) => {
    li.textContent = texts[i]!;
  });
  document.getElementById("ags-splash")!.dataset.readyText = "Tudo pronto";
}

const states = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#ags-splash-steps li")).map((li) => li.dataset.state);
const status = () => document.getElementById("ags-splash-status")?.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  mountSplash();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("tela de carregamento", () => {
  it("nasce na primeira etapa e avança sem voltar atrás", () => {
    expect(splashStep()).toBe(0);
    splashReached(2);
    expect(states()).toEqual(["done", "done", "now", "todo"]);
    expect(status()).toBe("Religando os terminais…");
    expect(document.getElementById("ags-splash-fill")!.style.width).toBe("58%");

    splashReached(1);
    expect(splashStep()).toBe(2);
  });

  it("no fim o robô acena e a tela some", async () => {
    const done = splashFinish();
    const root = document.getElementById("ags-splash")!;
    expect(states()).toEqual(["done", "done", "done", "done"]);
    expect(root.classList.contains("is-done")).toBe(true);
    expect(status()).toBe("Tudo pronto");

    await vi.advanceTimersByTimeAsync(SPLASH_WAVE_MS);
    expect(root.classList.contains("is-leaving")).toBe(true);
    await vi.advanceTimersByTimeAsync(SPLASH_LEAVE_MS);
    await done;
    expect(document.getElementById("ags-splash")).toBeNull();
  });

  it("segue o boot: terminais quando as tabs hidratam, e não espera os agentes para sempre", async () => {
    let hydrate: () => void = () => {};
    const tabsHydrated = new Promise<void>((resolve) => {
      hydrate = resolve;
    });
    const boot = followAppBoot({ tabsHydrated, agentsReady: new Promise(() => {}) });

    expect(splashStep()).toBe(2);
    hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(splashStep()).toBe(3);

    await vi.advanceTimersByTimeAsync(SPLASH_AGENTS_CAP_MS + SPLASH_WAVE_MS + SPLASH_LEAVE_MS);
    await boot;
    expect(document.getElementById("ags-splash")).toBeNull();
  });

  it("uma falha no boot não prende a tela", async () => {
    const boot = followAppBoot({ tabsHydrated: Promise.reject(new Error("x")), agentsReady: Promise.reject(new Error("y")) });
    await vi.advanceTimersByTimeAsync(SPLASH_WAVE_MS + SPLASH_LEAVE_MS);
    await boot;
    expect(document.getElementById("ags-splash")).toBeNull();
  });

  it("a atualização da base a tira na hora, sem aceno", () => {
    splashDismiss();
    expect(document.getElementById("ags-splash")).toBeNull();
    expect(() => splashReached(3)).not.toThrow();
  });
});

describe("a janela não pisca branca", () => {
  it("a janela principal nasce escondida e a página pede para aparecer", () => {
    const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.app.windows[0].visible).toBe(false);
    expect(INDEX).toContain("invoke('app_window_ready')");
  });

  it("restaurar a janela principal não a maximiza (no Windows isso a mostraria antes da hora)", () => {
    const manager = readFileSync(path.join(ROOT, "src-tauri/src/window/manager.rs"), "utf8");
    const reuse = manager.slice(manager.indexOf("if reuse_main && w.label == \"main\""), manager.indexOf("let tab_count"));
    expect(reuse).not.toContain(".maximize()");
  });
});
