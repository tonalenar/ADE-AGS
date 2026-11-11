/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const i18nResult = { t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { BrowserImportSetting } from "../BrowserImportSetting";

/** Lo que responde cada comando del backend. Un `throw` llega como la recusa del `invoke`. */
const respuestas: Record<string, (args?: unknown) => unknown> = {};

const FIREFOX = {
  id: "firefox",
  name: "Firefox",
  engine: "firefox",
  profiles: [{ id: "Profile0", name: "default-release" }],
  unavailable: null,
};
const CHROME = {
  id: "chrome",
  name: "Chrome",
  engine: "chromium",
  profiles: [
    { id: "Default", name: "Pessoa" },
    { id: "Profile 1", name: "Trabalho" },
  ],
  unavailable: null,
};
const SAFARI_SEM_ACESSO = { id: "safari", name: "Safari", engine: "safari", profiles: [], unavailable: "needs-full-disk-access" };
const SAFARI_LIBERADO = { ...SAFARI_SEM_ACESSO, profiles: [{ id: "default", name: "Safari" }], unavailable: null };
const REVISION = {
  profileName: "default-release",
  domains: [
    { domain: "github.com", cookies: 2 },
    { domain: "google.com", cookies: 1 },
  ],
  ignored: 1,
};
const GRAVADO = { domains: [{ domain: "github.com", cookies: 2 }], cookies: 2, skipped: 0 };
const PERFIL_ADE = "profile-11111111-1111-4111-8111-111111111111";

let container: HTMLDivElement;
let root: Root;

/** Deja correr las promesas ya resueltas, sin esperar el reloj real. */
async function asentar() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function montar() {
  await act(async () => {
    root.render(<BrowserImportSetting />);
  });
}

async function clic(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await asentar();
  });
}

function boton(clave: string): HTMLButtonElement {
  const encontrado = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(clave));
  if (!encontrado) throw new Error(`sin botón: ${clave}`);
  return encontrado;
}

function comandos(): string[] {
  return invokeMock.mock.calls.map(([comando]) => String(comando));
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation((comando: string, args?: unknown) => {
    const responder = respuestas[comando];
    if (!responder) return Promise.reject(new Error(`sin respuesta para ${comando}`));
    return Promise.resolve().then(() => responder(args));
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const clave of Object.keys(respuestas)) delete respuestas[clave];
});

function radio(id: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`#browser-import-source-${id}`);
  if (!el) throw new Error(`sem fonte: ${id}`);
  return el;
}

function selecao(rotulo: string): HTMLSelectElement {
  const el = [...container.querySelectorAll<HTMLSelectElement>("select")].find((s) => s.getAttribute("aria-label")?.startsWith(rotulo));
  if (!el) throw new Error(`sem seletor: ${rotulo}`);
  return el;
}

async function trocar(el: HTMLSelectElement, valor: string) {
  await act(async () => {
    el.value = valor;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await asentar();
  });
}

async function abrirAssistente() {
  await montar();
  await clic(boton("settings.browserImport.start"));
}

describe("importação do navegador: revisão antes de gravar", () => {
  it("nada é lido antes do clique: só montar a tela não chama o backend", async () => {
    await montar();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("lista os navegadores, revisa e só grava os domínios marcados, no perfil de destino", async () => {
    respuestas.browser_import_sources = () => [FIREFOX, CHROME];
    respuestas.browser_import_review = () => REVISION;
    respuestas.browser_import_apply = () => GRAVADO;
    await abrirAssistente();
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_sources");
    expect(radio("firefox").checked).toBe(true);
    await clic(boton("settings.browserImport.review"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_review", { sourceId: "firefox", profileId: "Profile0" });

    const marcas = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(marcas.map((m) => m.id)).toEqual(["browser-import-github.com", "browser-import-google.com"]);
    expect(marcas.some((m) => m.checked)).toBe(false);

    await clic(marcas[0]);
    await clic(boton("settings.browserImport.apply"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_apply", {
      sourceId: "firefox",
      profileId: "Profile0",
      domains: ["github.com"],
      targetProfileId: "default",
    });
    expect(container.textContent).toContain("settings.browserImport.done");
  });

  it("escolhe o navegador, o perfil de origem e o perfil de destino da ADE", async () => {
    localStorage.setItem("cc-browser-profiles-v1", JSON.stringify([{ id: PERFIL_ADE, name: "Trabalho ADE" }]));
    respuestas.browser_import_sources = () => [FIREFOX, CHROME];
    respuestas.browser_import_review = () => REVISION;
    respuestas.browser_import_apply = () => GRAVADO;
    await abrirAssistente();
    await clic(radio("chrome"));
    await trocar(selecao("settings.browserImport.profile"), "Profile 1");
    await trocar(selecao("settings.browserImport.target"), PERFIL_ADE);
    await clic(boton("settings.browserImport.review"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_review", { sourceId: "chrome", profileId: "Profile 1" });
    await clic(marcarTodos());
    await clic(boton("settings.browserImport.apply"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_apply", {
      sourceId: "chrome",
      profileId: "Profile 1",
      domains: ["github.com", "google.com"],
      targetProfileId: PERFIL_ADE,
    });
  });

  it("avisa do pedido do Keychain só para o Chromium", async () => {
    respuestas.browser_import_sources = () => [FIREFOX, CHROME];
    await abrirAssistente();
    expect(container.textContent).not.toContain("settings.browserImport.keychainNote");
    await clic(radio("chrome"));
    expect(container.textContent).toContain("settings.browserImport.keychainNote");
  });

  it("sem nenhum domínio marcado, o botão de importar fica parado e nada é gravado", async () => {
    respuestas.browser_import_sources = () => [FIREFOX];
    respuestas.browser_import_review = () => REVISION;
    await abrirAssistente();
    await clic(boton("settings.browserImport.review"));
    expect(boton("settings.browserImport.apply").disabled).toBe(true);
    expect(comandos()).not.toContain("browser_import_apply");
  });

  it("cancelar antes de confirmar volta ao início e não chama a importação", async () => {
    respuestas.browser_import_sources = () => [FIREFOX];
    respuestas.browser_import_review = () => REVISION;
    await abrirAssistente();
    await clic(boton("settings.browserImport.review"));
    await clic(marcarTodos());
    await clic(boton("settings.browserImport.cancel"));
    expect(boton("settings.browserImport.start")).toBeTruthy();
    expect(comandos()).not.toContain("browser_import_apply");
  });

  it("os cookies que não puderam ser decifrados aparecem no resultado", async () => {
    respuestas.browser_import_sources = () => [CHROME];
    respuestas.browser_import_review = () => REVISION;
    respuestas.browser_import_apply = () => ({ ...GRAVADO, skipped: 3 });
    await abrirAssistente();
    await clic(boton("settings.browserImport.review"));
    await clic(marcarTodos());
    await clic(boton("settings.browserImport.apply"));
    expect(container.textContent).toContain("settings.browserImport.skipped");
    expect(container.textContent).toContain('"count":3');
  });
});

describe("importação do navegador: fontes indisponíveis", () => {
  it("sem nenhum navegador compatível, a tela diz isso e não oferece revisar", async () => {
    respuestas.browser_import_sources = () => [];
    await abrirAssistente();
    expect(container.textContent).toContain("settings.browserImport.noSources");
    expect([...container.querySelectorAll("button")].some((b) => (b.textContent ?? "").startsWith("settings.browserImport.review"))).toBe(false);
  });

  it("navegador não instalado ou com cifra amarrada ao app aparece desabilitado, com o motivo", async () => {
    respuestas.browser_import_sources = () => [
      FIREFOX,
      { id: "edge", name: "Microsoft Edge", engine: "chromium", profiles: [], unavailable: "app-bound" },
      { id: "brave", name: "Brave", engine: "chromium", profiles: [], unavailable: "not-installed" },
    ];
    await abrirAssistente();
    expect(radio("edge").disabled).toBe(true);
    expect(radio("brave").disabled).toBe(true);
    expect(container.textContent).toContain("settings.browserImport.source.appBound");
    expect(container.textContent).toContain("settings.browserImport.source.notInstalled");
  });

  it("fonte de outro sistema nem aparece", async () => {
    respuestas.browser_import_sources = () => [FIREFOX, { id: "safari", name: "Safari", engine: "safari", profiles: [], unavailable: "unsupported-platform" }];
    await abrirAssistente();
    expect(container.querySelector("#browser-import-source-safari")).toBeNull();
  });

  it("navegador aberto pede para fechar e deixa verificar de novo", async () => {
    let aberto = true;
    respuestas.browser_import_sources = () => [{ ...CHROME, unavailable: aberto ? "browser-running" : null }];
    await abrirAssistente();
    expect(container.textContent).toContain("settings.browserImport.quitStep");
    expect(comandos()).not.toContain("browser_import_review");
    aberto = false;
    await clic(boton("settings.browserImport.recheck"));
    expect(boton("settings.browserImport.review")).toBeTruthy();
  });

  it("Safari sem Acesso Total ao Disco mostra o passo, abre o painel certo e libera depois de verificar", async () => {
    let liberado = false;
    respuestas.browser_import_sources = () => [liberado ? SAFARI_LIBERADO : SAFARI_SEM_ACESSO];
    respuestas.browser_import_open_full_disk_access = () => undefined;
    await abrirAssistente();
    expect(container.textContent).toContain("settings.browserImport.fullDiskAccessStep");
    expect([...container.querySelectorAll("button")].some((b) => (b.textContent ?? "").startsWith("settings.browserImport.review"))).toBe(false);
    await clic(boton("settings.browserImport.openSettings"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_open_full_disk_access");
    liberado = true;
    await clic(boton("settings.browserImport.recheck"));
    expect(boton("settings.browserImport.review")).toBeTruthy();
  });

  it("se abrir os Ajustes falhar, a recusa aparece", async () => {
    respuestas.browser_import_sources = () => [SAFARI_SEM_ACESSO];
    respuestas.browser_import_open_full_disk_access = () => {
      throw "O Acesso Total ao Disco existe só no macOS.";
    };
    await abrirAssistente();
    await clic(boton("settings.browserImport.openSettings"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("settings.browserImport.error.generic");
  });
});

describe("importação do navegador: recusas do backend", () => {
  it("com o navegador aberto na revisão, mostra a recusa, relê a lista e não grava nada", async () => {
    let chamadas = 0;
    respuestas.browser_import_sources = () => {
      chamadas += 1;
      return [{ ...FIREFOX, unavailable: chamadas > 1 ? "browser-running" : null }];
    };
    respuestas.browser_import_review = () => {
      throw { code: "browser-running", detail: null };
    };
    await abrirAssistente();
    await clic(boton("settings.browserImport.review"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("settings.browserImport.error.browserRunning");
    expect(chamadas).toBe(2);
    expect(container.textContent).toContain("settings.browserImport.quitStep");
    expect(comandos()).not.toContain("browser_import_apply");
  });

  it("a recusa do Keychain na gravação fica na revisão, com a frase certa, sem dar a importação por feita", async () => {
    respuestas.browser_import_sources = () => [CHROME];
    respuestas.browser_import_review = () => REVISION;
    respuestas.browser_import_apply = () => {
      throw { code: "needs-keychain-approval", detail: null };
    };
    await abrirAssistente();
    await clic(boton("settings.browserImport.review"));
    await clic(marcarTodos());
    await clic(boton("settings.browserImport.apply"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("settings.browserImport.error.needsKeychainApproval");
    expect(container.textContent).not.toContain("settings.browserImport.done");
    expect(boton("settings.browserImport.apply")).toBeTruthy();
  });

  it("a falta de Acesso Total ao Disco durante a leitura volta ao passo do Safari", async () => {
    let negado = false;
    respuestas.browser_import_sources = () => [negado ? SAFARI_SEM_ACESSO : SAFARI_LIBERADO];
    respuestas.browser_import_review = () => {
      negado = true;
      throw { code: "needs-full-disk-access", detail: null };
    };
    await abrirAssistente();
    await clic(boton("settings.browserImport.review"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("settings.browserImport.error.needsFullDiskAccess");
    expect(container.textContent).toContain("settings.browserImport.fullDiskAccessStep");
  });
});

function marcarTodos(): HTMLButtonElement {
  return boton("settings.browserImport.selectAll");
}
