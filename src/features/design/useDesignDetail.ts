import { useCallback, useEffect, useRef, useState } from "react";

import { designApi, onDesignChanged, type DesignDetail } from "@/features/canvas/design/designApi";

/**
 * Um design inteiro (páginas, pranchetas, notas, comentários), relido a cada `design-changed` dele.
 * Uma resposta atrasada de uma leitura anterior nunca sobrescreve a mais nova.
 */
export function useDesignDetail(designId: string | null) {
  const [detail, setDetail] = useState<DesignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!designId) return;
    const mine = ++seq.current;
    try {
      const d = await designApi.get(designId);
      if (mine !== seq.current) return;
      setDetail(d);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [designId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setLoading(true);
    void reload();
  }, [reload]);

  // O evento traz o design que mudou; sem id (backend antigo), relê por via das dúvidas.
  useEffect(() => onDesignChanged((p) => {
    if (!p?.designId || p.designId === designId) void reload();
  }), [reload, designId]);

  return { detail, error, loading, reload };
}
