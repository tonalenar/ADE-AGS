/**
 * A tela de carregamento: o robô do `index.html`, que a janela pinta antes de o bundle chegar.
 *
 * Ela já nasce com a primeira etapa ("abrindo a janela") em andamento. Daqui o app avança as etapas
 * quando cada coisa fica pronta de verdade e, no fim, o robô acena e a tela se dissolve. O estado
 * mora no próprio DOM (a etapa atual em `data-state` de cada item): sem o elemento, tudo aqui é nada.
 */

/** Quantas etapas a lista tem: janela, workspaces, terminais, agentes. */
export const SPLASH_STEPS = 4;
/** Quanto o robô acena antes de a tela começar a sumir. */
export const SPLASH_WAVE_MS = 700;
/** A duração do esmaecer (a `transition` de `#ags-splash` no `index.html`). */
export const SPLASH_LEAVE_MS = 300;
/** Quanto a última etapa espera a detecção dos agentes antes de liberar a tela. */
export const SPLASH_AGENTS_CAP_MS = 2_500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function splashRoot(doc: Document): HTMLElement | null {
  return doc.getElementById("ags-splash");
}

/** A etapa atual: a primeira que ainda não terminou. */
export function splashStep(doc: Document = document): number {
  const items = Array.from(doc.querySelectorAll<HTMLElement>("#ags-splash-steps li"));
  const now = items.findIndex((li) => li.dataset.state !== "done");
  return now === -1 ? items.length : now;
}

/** As etapas antes de `step` terminaram e `step` é a da vez. Nunca volta atrás. */
export function splashReached(step: number, doc: Document = document): void {
  const root = splashRoot(doc);
  if (!root || root.classList.contains("is-done")) return;
  const target = Math.min(step, SPLASH_STEPS);
  if (target <= splashStep(doc)) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>("#ags-splash-steps li"));
  items.forEach((li, i) => {
    li.dataset.state = i < target ? "done" : i === target ? "now" : "todo";
  });
  const fill = doc.getElementById("ags-splash-fill");
  if (fill) fill.style.width = target >= SPLASH_STEPS ? "100%" : `${target * 25 + 8}%`;
  const status = doc.getElementById("ags-splash-status");
  const current = items[target]?.textContent;
  if (status && current) status.textContent = `${current}…`;
}

/** Tudo carregado: o robô acena e a tela se dissolve no app. */
export async function splashFinish(doc: Document = document): Promise<void> {
  const root = splashRoot(doc);
  if (!root || root.classList.contains("is-done")) return;
  splashReached(SPLASH_STEPS, doc);
  root.classList.add("is-done");
  const status = doc.getElementById("ags-splash-status");
  if (status) status.textContent = root.dataset.readyText ?? "";
  await wait(SPLASH_WAVE_MS);
  root.classList.add("is-leaving");
  await wait(SPLASH_LEAVE_MS);
  root.remove();
}

/** Some na hora, sem aceno: o app vai mostrar outra tela (a de atualização da base). */
export function splashDismiss(doc: Document = document): void {
  splashRoot(doc)?.remove();
}

/**
 * Segue o boot a partir da casca do app montada (a base e o catálogo já estão prontos): os terminais
 * religam quando as tabs da janela hidratam, e a última etapa espera a detecção dos agentes até
 * `capMs`. Uma falha em qualquer das duas não segura a tela.
 */
export async function followAppBoot(
  deps: { tabsHydrated: Promise<unknown>; agentsReady: Promise<unknown>; capMs?: number },
  doc: Document = document,
): Promise<void> {
  splashReached(2, doc);
  await deps.tabsHydrated.catch(() => undefined);
  splashReached(3, doc);
  await Promise.race([deps.agentsReady.catch(() => undefined), wait(deps.capMs ?? SPLASH_AGENTS_CAP_MS)]);
  await splashFinish(doc);
}
