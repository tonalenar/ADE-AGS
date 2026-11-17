import { useEffect, useRef } from "react";

/**
 * A vista de um Portal do canvas vive enquanto o Portal existe. O diretório de referência (`cwd`) muda quando o primeiro
 * terminal do canvas muda de pasta: a vista continua a mesma, e só o `cwd` dela é atualizado (a página não é recriada).
 * Quem desmonta o Portal solta a vista. A URL inicial só conta ao criar a vista.
 */
export function usePortalViewLifetime(
  id: string,
  cwd: string,
  ensure: (id: string, cwd: string) => void,
  drop: (id: string) => void,
  setCwd: (id: string, cwd: string) => void,
): void {
  const viewCwd = useRef<string | null>(null);
  useEffect(() => {
    ensure(id, cwd);
    viewCwd.current = cwd;
    return () => drop(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (viewCwd.current === null || viewCwd.current === cwd) return;
    viewCwd.current = cwd;
    setCwd(id, cwd);
  }, [id, cwd, setCwd]);
}
