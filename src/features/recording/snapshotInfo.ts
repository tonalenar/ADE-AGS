import { useEffect, useState } from "react";

import { desktopSnapshotInfo } from "./ipc";
import { isSnapshotFile, snapshotCaption, type SnapshotCaption, type SnapshotInfo } from "./snapshotTargets";

const cache = new Map<string, Promise<SnapshotInfo | null>>();

/**
 * O JSON ao lado de uma foto do SnapShot, lido uma vez por caminho. Foto de outro lugar ou sem o prefixo do app
 * não consulta nada. Falha não fica no cache: a próxima vez tenta de novo.
 */
export function snapshotInfoFor(path: string): Promise<SnapshotInfo | null> {
  if (!isSnapshotFile(path)) return Promise.resolve(null);
  let pending = cache.get(path);
  if (!pending) {
    pending = desktopSnapshotInfo([path])
      .then((items) => items[0] ?? null)
      .catch(() => {
        cache.delete(path);
        return null;
      });
    cache.set(path, pending);
  }
  return pending;
}

/** A legenda do anexo, quando a foto é do SnapShot e tem o JSON ao lado. Sem isso, o anexo segue só com o nome. */
export function useSnapshotCaption(path: string): SnapshotCaption | null {
  const [caption, setCaption] = useState<SnapshotCaption | null>(null);
  useEffect(() => {
    let active = true;
    void snapshotInfoFor(path).then((info) => {
      if (active) setCaption(snapshotCaption(info));
    });
    return () => {
      active = false;
    };
  }, [path]);
  return caption;
}
