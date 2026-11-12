import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Lightbox, type LightboxImage } from "./Lightbox";

interface MediaViewerApi {
  register: (owner: string, items: LightboxImage[]) => void;
  unregister: (owner: string) => void;
  open: (path: string) => void;
}

const MediaViewerContext = createContext<MediaViewerApi | null>(null);

export function useMediaViewer(): MediaViewerApi | null {
  return useContext(MediaViewerContext);
}

/** Compartilha a galeria entre anexos do composer e de todas as mensagens montadas da conversa. */
export function MediaViewerProvider({ children, target, cwd }: { children: React.ReactNode; target: string | null; cwd: string | null }) {
  const [sources, setSources] = useState<Record<string, LightboxImage[]>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const media = useMemo(() => Object.values(sources).flat().filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index), [sources]);
  const register = useCallback((owner: string, items: LightboxImage[]) => setSources((all) => ({ ...all, [owner]: items })), []);
  const unregister = useCallback((owner: string) => setSources((all) => { const next = { ...all }; delete next[owner]; return next; }), []);
  const open = useCallback((path: string) => setActivePath(path), []);
  const index = activePath === null ? -1 : media.findIndex((item) => item.path === activePath);
  const api = useMemo(() => ({ register, unregister, open }), [register, unregister, open]);

  return <MediaViewerContext.Provider value={api}>
    {children}
    {index >= 0 && <Lightbox images={media} index={index} composerTarget={target} cwd={cwd} onIndex={(next) => setActivePath(media[next]?.path ?? null)} onClose={() => setActivePath(null)} />}
  </MediaViewerContext.Provider>;
}
