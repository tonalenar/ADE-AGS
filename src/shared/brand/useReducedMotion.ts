import { useEffect, useState } from "react";

function motionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
}

/** `true` quando o sistema pede menos movimento. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => motionQuery()?.matches ?? false);
  useEffect(() => {
    const mq = motionQuery();
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}
