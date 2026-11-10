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

const PERFIL = { id: "Profile0", name: "default-release" };
const REVISION = {
  profileName: "default-release",
  domains: [
    { domain: "github.com", cookies: 2 },
    { domain: "google.com", cookies: 1 },
  ],
  ignored: 1,
};

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

describe("importação do navegador: revisão antes de gravar", () => {
  it("só grava os domínios marcados, depois de revisar", async () => {
    respuestas.browser_import_profiles = () => [PERFIL];
    respuestas.browser_import_review = () => REVISION;
    respuestas.browser_import_apply = () => ({ domains: [{ domain: "github.com", cookies: 2 }], cookies: 2 });
    await montar();
    await clic(boton("settings.browserImport.start"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_profiles");
    await clic(boton("settings.browserImport.review"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_review", { profileId: "Profile0" });

    const marcas = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(marcas.map((m) => m.id)).toEqual(["browser-import-github.com", "browser-import-google.com"]);
    expect(marcas.some((m) => m.checked)).toBe(false);

    await clic(marcas[0]);
    await clic(boton("settings.browserImport.apply"));
    expect(invokeMock).toHaveBeenLastCalledWith("browser_import_apply", { profileId: "Profile0", domains: ["github.com"] });
    expect(container.textContent).toContain("settings.browserImport.done");
  });

  it("sem nenhum domínio marcado, o botão de importar fica parado e nada é gravado", async () => {
    respuestas.browser_import_profiles = () => [PERFIL];
    respuestas.browser_import_review = () => REVISION;
    await montar();
    await clic(boton("settings.browserImport.start"));
    await clic(boton("settings.browserImport.review"));
    expect(boton("settings.browserImport.apply").disabled).toBe(true);
    expect(comandos()).not.toContain("browser_import_apply");
  });

  it("com o Firefox aberto, mostra a recusa e não grava nada", async () => {
    respuestas.browser_import_profiles = () => [PERFIL];
    respuestas.browser_import_review = () => {
      throw { code: "browser-running", detail: null };
    };
    await montar();
    await clic(boton("settings.browserImport.start"));
    await clic(boton("settings.browserImport.review"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("settings.browserImport.error.browserRunning");
    expect(comandos()).not.toContain("browser_import_apply");
  });

  it("cancelar antes de confirmar volta ao início e não chama a importação", async () => {
    respuestas.browser_import_profiles = () => [PERFIL];
    respuestas.browser_import_review = () => REVISION;
    await montar();
    await clic(boton("settings.browserImport.start"));
    await clic(boton("settings.browserImport.review"));
    await clic(marcarTodos());
    await clic(boton("settings.browserImport.cancel"));
    expect(boton("settings.browserImport.start")).toBeTruthy();
    expect(comandos()).not.toContain("browser_import_apply");
  });

  it("sem perfil do Firefox, a tela diz isso e não oferece revisar", async () => {
    respuestas.browser_import_profiles = () => [];
    await montar();
    await clic(boton("settings.browserImport.start"));
    expect(container.textContent).toContain("settings.browserImport.noProfiles");
    expect([...container.querySelectorAll("button")].some((b) => (b.textContent ?? "").startsWith("settings.browserImport.review"))).toBe(false);
  });
});

function marcarTodos(): HTMLButtonElement {
  return boton("settings.browserImport.selectAll");
}
