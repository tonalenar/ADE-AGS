/**
 * As partes da gravação do navegador que se testam sem o componente (ver `BrowserTab.tsx`).
 */

/**
 * Teto de quadros por segundo. Cada quadro rasteriza a página inteira (ou passa pelo IPC, no Chrome real), e a
 * preferência deixava chegar a 60. Sem medição, o teto conservador é o padrão de 30; a medição fica por fazer (A204).
 */
export const RECORDING_FPS_CEILING = 30;

/** O fps que a gravação usa: a preferência, limitada ao teto e a pelo menos 1 quadro por segundo. */
export function effectiveRecordingFps(preference: number): number {
  return Math.min(Math.max(1, preference), RECORDING_FPS_CEILING);
}

/**
 * A foto inicial da gravação é um `await`. Se a aba foi desmontada nesse meio tempo, devolve `null`: o cleanup já
 * rodou e não viu gravador, então não se pode criar canvas, stream nem gravador para uma aba que não existe (A187).
 */
export async function captureUnlessDisposed<T>(capture: () => Promise<T>, isDisposed: () => boolean): Promise<T | null> {
  const first = await capture();
  return isDisposed() ? null : first;
}
