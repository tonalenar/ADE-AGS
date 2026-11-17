import { useEffect, useRef } from "react";

/**
 * A vista de um Portal do canvas vive enquanto o Portal existe. O diretório de referência (`cwd`) muda quando o
 * primeiro terminal do canvas muda de pasta: esse vai por ref, e o efeito roda só com `id`, para a vista (e a
 * página nela) não ser recriada a cada troca de pasta. Quem desmonta o Portal solta a vista.
 */
export function usePortalViewLifetime(id: string, cwd: string, ensure: (id: string, cwd: string) => void, drop: (id: string) => void): void {
  const currentCwd = useRef(cwd);
  currentCwd.current = cwd;
  useEffect(() => {
    ensure(id, currentCwd.current);
    return () => drop(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
}
