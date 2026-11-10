export const MOTION_DURATION_KEY = "cc-motion-duration-ms";
export const MOTION_DURATION = { min: 0, max: 400, step: 10, default: 170 } as const;

export function clampMotionDuration(value: number): number {
  if (!Number.isFinite(value)) return MOTION_DURATION.default;
  const stepped = Math.round(value / MOTION_DURATION.step) * MOTION_DURATION.step;
  return Math.min(MOTION_DURATION.max, Math.max(MOTION_DURATION.min, stepped));
}

export function readMotionDuration(): number {
  try {
    const raw = Number(localStorage.getItem(MOTION_DURATION_KEY));
    return localStorage.getItem(MOTION_DURATION_KEY) === null ? MOTION_DURATION.default : clampMotionDuration(raw);
  } catch {
    return MOTION_DURATION.default;
  }
}

export function applyMotionDuration(duration: number): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  const base = clampMotionDuration(duration);
  root.setProperty("--nui-duration", `${base}ms`);
  root.setProperty("--nui-duration-fast", `${Math.round(base * 0.65)}ms`);
  root.setProperty("--cc-fast", `var(--nui-duration-fast)`);
  root.setProperty("--cc-base", `var(--nui-duration)`);
  root.setProperty("--cc-slow", `${Math.round(base * 1.4)}ms`);
}

export function saveMotionDuration(duration: number): number {
  const value = clampMotionDuration(duration);
  try {
    localStorage.setItem(MOTION_DURATION_KEY, String(value));
  } catch {
    // A preferência continua aplicada nesta sessão se o armazenamento estiver indisponível.
  }
  applyMotionDuration(value);
  return value;
}

/** Aplica o valor persistido antes da primeira renderização da janela. */
if (typeof document !== "undefined") applyMotionDuration(readMotionDuration());
