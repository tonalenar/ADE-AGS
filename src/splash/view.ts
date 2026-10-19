/**
 * O que a janelinha de abertura (`splash.html`) mostra: as quatro etapas, a barra e, no fim, o aceno.
 * O estado mora no próprio DOM (a etapa de cada item em `data-state`); sem o elemento, nada acontece.
 */

/** Quantas etapas a lista tem: janela, workspaces, terminais, agentes. */
export const SPLASH_STEPS = 4;

/** Os textos, antes de o i18n existir: o mesmo idioma que o app vai escolher. */
export function splashTexts(saved: string | null, system: string): { steps: string[]; ready: string } {
  const lang = (saved || system || "en").toLowerCase();
  if (lang.startsWith("pt")) {
    return { steps: ["Abrindo a janela", "Carregando os workspaces", "Religando os terminais", "Conectando os agentes"], ready: "Tudo pronto" };
  }
  if (lang.startsWith("es")) {
    return { steps: ["Abriendo la ventana", "Cargando los workspaces", "Reconectando las terminales", "Conectando los agentes"], ready: "Todo listo" };
  }
  return { steps: ["Opening the window", "Loading workspaces", "Reattaching terminals", "Connecting agents"], ready: "All set" };
}

/** Escreve os textos nas etapas. */
export function fillSplashTexts(texts: { steps: string[]; ready: string }, doc: Document = document): void {
  doc.querySelectorAll<HTMLElement>("#ags-splash-steps li").forEach((li, i) => {
    li.textContent = texts.steps[i] ?? "";
  });
  const root = doc.getElementById("ags-splash");
  if (root) root.dataset.readyText = texts.ready;
  const status = doc.getElementById("ags-splash-status");
  if (status) status.textContent = `${texts.steps[0]}…`;
}

/** A etapa atual: a primeira que ainda não terminou. */
export function splashStep(doc: Document = document): number {
  const items = Array.from(doc.querySelectorAll<HTMLElement>("#ags-splash-steps li"));
  const now = items.findIndex((li) => li.dataset.state !== "done");
  return now === -1 ? items.length : now;
}

/** As etapas antes de `step` terminaram e `step` é a da vez. Nunca volta atrás. Em `SPLASH_STEPS`, o fim:
 *  tudo feito e o robô acena. */
export function showSplashStep(step: number, doc: Document = document): void {
  const root = doc.getElementById("ags-splash");
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
  if (target >= SPLASH_STEPS) {
    root.classList.add("is-done");
    if (status) status.textContent = root.dataset.readyText ?? "";
    return;
  }
  const current = items[target]?.textContent;
  if (status && current) status.textContent = `${current}…`;
}
