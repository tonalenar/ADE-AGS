// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { followAppBoot, SPLASH_AGENTS_CAP_MS, SPLASH_DONE, SPLASH_WAVE_MS } from "@/app/splash";
import { fillSplashTexts, showSplashStep, splashStep, splashTexts } from "@/splash/view";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const SPLASH_HTML = read("splash.html");

/** O corpo do `splash.html` de verdade, sem o <script> (o happy-dom tentaria baixá-lo). */
function mountSplash() {
  document.body.innerHTML = SPLASH_HTML.slice(SPLASH_HTML.indexOf("<body>") + 6, SPLASH_HTML.indexOf("</body>"))
    .replace(/<script[\s\S]*?<\/script>/g, "");
  fillSplashTexts(splashTexts("pt-BR", "en-US"));
}

const states = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#ags-splash-steps li")).map((li) => li.dataset.state);
const status = () => document.getElementById("ags-splash-status")?.textContent;

describe("janelinha de abertura", () => {
  beforeEach(mountSplash);
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fala o idioma do app: o salvo, senão o do sistema", () => {
    expect(splashTexts("pt-BR", "en-US").steps[0]).toBe("Abrindo a janela");
    expect(splashTexts(null, "es-AR").ready).toBe("Todo listo");
    expect(splashTexts(null, "").steps[2]).toBe("Reattaching terminals");
    expect(status()).toBe("Abrindo a janela…");
  });

  it("nasce na primeira etapa e avança sem voltar atrás", () => {
    expect(splashStep()).toBe(0);
    showSplashStep(2);
    expect(states()).toEqual(["done", "done", "now", "todo"]);
    expect(status()).toBe("Religando os terminais…");
    expect(document.getElementById("ags-splash-fill")!.style.width).toBe("58%");
    showSplashStep(1);
    expect(splashStep()).toBe(2);
  });

  it("no fim tudo fica feito e o robô acena", () => {
    showSplashStep(SPLASH_DONE);
    expect(states()).toEqual(["done", "done", "done", "done"]);
    expect(document.getElementById("ags-splash")!.classList.contains("is-done")).toBe(true);
    expect(status()).toBe("Tudo pronto");
  });
});

describe("o boot da janela principal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function io() {
    const steps: number[] = [];
    const done = vi.fn(async () => {});
    return { steps, done, io: { step: (s: number) => steps.push(s), done } };
  }

  it("terminais quando as tabs hidratam, agentes com teto, aceno e só então o app aparece", async () => {
    let hydrate: () => void = () => {};
    const tabsHydrated = new Promise<void>((resolve) => {
      hydrate = resolve;
    });
    const t = io();
    const boot = followAppBoot({ tabsHydrated, agentsReady: new Promise(() => {}) }, t.io);

    expect(t.steps).toEqual([2]);
    hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.steps).toEqual([2, 3]);

    await vi.advanceTimersByTimeAsync(SPLASH_AGENTS_CAP_MS);
    expect(t.steps).toEqual([2, 3, SPLASH_DONE]);
    expect(t.done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SPLASH_WAVE_MS);
    await boot;
    expect(t.done).toHaveBeenCalledOnce();
  });

  it("uma falha no boot não prende o app atrás da abertura", async () => {
    const t = io();
    const boot = followAppBoot({ tabsHydrated: Promise.reject(new Error("x")), agentsReady: Promise.reject(new Error("y")) }, t.io);
    await vi.advanceTimersByTimeAsync(SPLASH_WAVE_MS);
    await boot;
    expect(t.done).toHaveBeenCalledOnce();
  });
});

describe("a janela não pisca branca nem em tela cheia", () => {
  it("a principal nasce escondida e a abertura é uma janelinha central", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.app.windows[0].visible).toBe(false);
    const splash = read("src-tauri/src/window/splash.rs");
    expect(splash).toContain("config.center = true;");
    expect(splash).toContain("config.visible = false;");
    expect(read("index.html")).not.toContain("ags-splash");
  });

  it("restaurar a janela principal não a maximiza (no Windows isso a mostraria antes da hora)", () => {
    const manager = read("src-tauri/src/window/manager.rs");
    const reuse = manager.slice(manager.indexOf("if reuse_main && w.label == \"main\""), manager.indexOf("let tab_count"));
    expect(reuse).not.toContain(".maximize()");
  });

  it("a página da abertura não tem script inline (a CSP só libera os do build)", () => {
    expect(SPLASH_HTML.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();
  });
});
