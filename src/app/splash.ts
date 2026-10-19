import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * O boot da janela principal visto pela janelinha de abertura (`splash.html`, ver
 * `src-tauri/src/window/splash.rs`). A principal carrega escondida e avisa cada etapa quando ela fica
 * pronta de verdade; no fim o robô acena e a principal aparece, já maximizada.
 *
 * Só a janela "main" conversa com a abertura: as outras de um workspace abrem depois, já visíveis.
 */

/** O fim, na contagem da janelinha (as quatro etapas feitas). */
export const SPLASH_DONE = 4;
/** Quanto o robô acena antes de o app aparecer. */
export const SPLASH_WAVE_MS = 700;
/** Quanto a última etapa espera a detecção dos agentes antes de liberar o app. */
export const SPLASH_AGENTS_CAP_MS = 2_500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

/** A etapa `step` é a da vez (as anteriores terminaram). */
export function reportBootStep(step: number): void {
  if (!isMainWindow()) return;
  invoke("app_boot_progress", { step }).catch(() => undefined);
}

/** Mostra o app e tira a abertura, sem aceno (ex.: a tela de atualização da base precisa aparecer). */
export function revealApp(): Promise<void> {
  if (!isMainWindow()) return Promise.resolve();
  return invoke("app_boot_done").then(() => undefined, () => undefined);
}

/**
 * Segue o boot a partir da casca do app montada (a base e o catálogo já estão prontos): os terminais
 * religam quando as tabs hidratam, e a última etapa espera a detecção dos agentes até `capMs`. Uma falha
 * em qualquer das duas não segura o app.
 */
export async function followAppBoot(
  deps: { tabsHydrated: Promise<unknown>; agentsReady: Promise<unknown>; capMs?: number; waveMs?: number },
  io: { step: (step: number) => void; done: () => Promise<void> } = { step: reportBootStep, done: revealApp },
): Promise<void> {
  io.step(2);
  await deps.tabsHydrated.catch(() => undefined);
  io.step(3);
  await Promise.race([deps.agentsReady.catch(() => undefined), wait(deps.capMs ?? SPLASH_AGENTS_CAP_MS)]);
  io.step(SPLASH_DONE);
  await wait(deps.waveMs ?? SPLASH_WAVE_MS);
  await io.done();
}
