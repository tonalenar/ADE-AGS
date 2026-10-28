/**
 * Os guias de revisão sendo gerados agora, fora do componente: gerar leva minutos, e quem
 * volta para a lista e reabre o PR tem que ver "gerando…" e depois o resultado, não um
 * botão de novo (que pediria um segundo guia e gastaria cota em dobro).
 */
import { create } from "zustand";

import { reviewGuideGenerate } from "./ipc";
import { forgeErrorOf, type GuideOutcome, type GuideRequest } from "./types";

export type GuideJob =
  | { status: "running"; startedAt: number }
  | { status: "done"; outcome: GuideOutcome }
  | { status: "error"; message: string };

interface ReviewGuideState {
  jobs: Record<string, GuideJob>;
}

export const useReviewGuideStore = create<ReviewGuideState>(() => ({ jobs: {} }));

export const guideJobKey = (cwd: string, number: number) => `${cwd}#${number}`;

const setJob = (key: string, job: GuideJob | null) =>
  useReviewGuideStore.setState((s) => {
    const jobs = { ...s.jobs };
    if (job) jobs[key] = job;
    else delete jobs[key];
    return { jobs };
  });

/** Pede o guia. Um segundo pedido do mesmo PR enquanto o primeiro corre não faz nada. */
export async function startGuide(cwd: string, number: number, request: GuideRequest): Promise<void> {
  const key = guideJobKey(cwd, number);
  if (useReviewGuideStore.getState().jobs[key]?.status === "running") return;
  setJob(key, { status: "running", startedAt: Date.now() });
  try {
    setJob(key, { status: "done", outcome: await reviewGuideGenerate(cwd, number, request) });
  } catch (e) {
    setJob(key, { status: "error", message: forgeErrorOf(e).message });
  }
}

/** Esquece o resultado já mostrado (o guia válido foi para o cache). */
export const clearGuideJob = (cwd: string, number: number) => setJob(guideJobKey(cwd, number), null);
