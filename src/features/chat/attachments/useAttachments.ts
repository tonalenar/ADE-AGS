import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { savePastedImage } from "@/features/terminal/ipc";

import { addAttachments, formatSize, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, type Attachment, type Rejected } from "./attachModel";
import { inspectPaths, type Inspected } from "./ipc";

/** As imagens que o backend aceita salvar (as mesmas de `save_pasted_image`). */
const PASTE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function fromInspected(info: Inspected): Attachment {
  return {
    id: info.path, path: info.path, name: info.name, kind: info.kind, mime: info.mime, size: info.size, preview: null, temp: false,
    ...(info.error ? { error: info.error } : {}),
  };
}

/** Os caminhos de uma lista `text/uri-list` (arquivos copiados no Finder); só `file://`. Pura. */
export function pathsFromUriList(list: string): string[] {
  return list.split(/\r?\n/)
    .filter((line) => line.startsWith("file://"))
    .map((line) => { try { return decodeURIComponent(new URL(line).pathname); } catch { return ""; } })
    .filter((p) => p.length > 0);
}

/**
 * Os anexos de uma mensagem do composer: colar (imagem do clipboard, que vai para a pasta temporária do
 * app, e arquivos copiados), soltar caminhos e remover. As regras de limite e repetição são de
 * `attachModel`; os avisos (limite, erro de leitura) ficam em `notices` e nunca bloqueiam o texto.
 */
export function useAttachments() {
  const { t } = useTranslation();
  const [list, setList] = useState<Attachment[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const current = useRef<Attachment[]>([]);

  const describe = useCallback((r: Rejected): string => {
    switch (r.reason) {
      case "tooMany": return t("chat.attach.notice.tooMany", { name: r.name, max: MAX_ATTACHMENTS });
      case "tooBig": return t("chat.attach.notice.tooBig", { name: r.name, max: formatSize(MAX_FILE_BYTES) });
      case "totalTooBig": return t("chat.attach.notice.totalTooBig", { name: r.name, max: formatSize(MAX_TOTAL_BYTES) });
      default: return t("chat.attach.notice.error", { name: r.name, detail: r.detail ?? "" });
    }
  }, [t]);

  const add = useCallback((incoming: Attachment[], extra: string[] = []) => {
    const next = addAttachments(current.current, incoming);
    current.current = next.list;
    setList(next.list);
    setNotices([...extra, ...next.rejected.map(describe)]);
  }, [describe]);

  /** Caminhos que a pessoa soltou ou escolheu: só se confere o que são (nada é lido). */
  const addPaths = useCallback(async (paths: string[]) => {
    const unique = [...new Set(paths.filter((p) => p.length > 0))];
    if (unique.length === 0) return;
    try {
      add((await inspectPaths(unique)).map(fromInspected));
    } catch (e) {
      setNotices([t("chat.attach.notice.inspect", { error: String(e) })]);
    }
  }, [add, t]);

  /** Arquivos que vieram do clipboard sem caminho: só imagem pode ser salva (numa pasta temporária do app). */
  const addFiles = useCallback(async (files: File[]) => {
    const out: Attachment[] = [];
    const extra: string[] = [];
    for (const file of files) {
      const name = !file.name || /^image\.\w+$/i.test(file.name) ? `${t("chat.attach.pastedName")}.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}` : file.name;
      if (!PASTE_MIMES.has(file.type)) { extra.push(t("chat.attach.notice.noPath", { name })); continue; }
      if (file.size > MAX_IMAGE_BYTES) { extra.push(t("chat.attach.notice.tooBig", { name, max: formatSize(MAX_IMAGE_BYTES) })); continue; }
      try {
        const path = await savePastedImage(new Uint8Array(await file.arrayBuffer()), file.type);
        out.push({ id: path, path, name, kind: "image", mime: file.type, size: file.size, preview: URL.createObjectURL(file), temp: true });
      } catch (e) {
        extra.push(t("chat.attach.notice.saveFailed", { name, error: String(e) }));
      }
    }
    add(out, extra);
  }, [add, t]);

  /** Cmd/Ctrl+V na caixa: imagem e arquivos copiados viram anexo; texto comum passa para a caixa como sempre. */
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    const paths = pathsFromUriList(e.clipboardData.getData("text/uri-list"));
    if (files.length === 0 && paths.length === 0) return;
    e.preventDefault();
    if (paths.length > 0) void addPaths(paths);
    else void addFiles(files);
  }, [addFiles, addPaths]);

  const remove = useCallback((id: string) => {
    const gone = current.current.find((a) => a.id === id);
    if (gone?.preview?.startsWith("blob:")) URL.revokeObjectURL(gone.preview);
    current.current = current.current.filter((a) => a.id !== id);
    setList(current.current);
  }, []);

  const clear = useCallback(() => {
    for (const a of current.current) if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview);
    current.current = [];
    setList([]);
    setNotices([]);
  }, []);

  useEffect(() => () => { for (const a of current.current) if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview); }, []);

  return { list, notices, addPaths, addFiles, onPaste, remove, clear, dismissNotices: () => setNotices([]) };
}
