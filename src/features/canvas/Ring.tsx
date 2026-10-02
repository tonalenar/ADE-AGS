/** Un anillo de progreso: el arco es `percent` (0–100) del círculo. `null` = no se sabe. */
export function Ring({ percent, color, size = 22, stroke = 2.6 }: { percent: number | null; color: string; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(c * value) / 100} ${c}`} opacity={percent === null ? 0.25 : 1}
        style={{ transition: "stroke-dasharray 600ms ease" }} />
    </svg>
  );
}

export const RING_COLORS = { claude: "#f08a5d", codex: "#34c79b", gemini: "#6aa5f5" } as const;
