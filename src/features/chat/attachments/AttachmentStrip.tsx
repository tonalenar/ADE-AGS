import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

import { FilesIcon, FolderIcon, XIcon } from "../chatIcons";
import { formatSize, type AttachmentKind } from "./attachModel";
import { Lightbox } from "./Lightbox";
import { openAttachment } from "./openAttachment";
import { useImagePreview } from "./useImagePreview";

/** O que a fileira mostra: o anexo do composer ou o lido do texto de uma mensagem enviada. */
export interface ShownAttachment {
  path: string;
  name: string;
  kind: AttachmentKind;
  size: number | null;
  /** A prévia que já se tem (imagem colada). */
  preview?: string | null;
}

/** A pasta da conversa à vista: onde abrir um arquivo anexado (as bolhas da timeline não a recebem por prop). */
export const AttachCwdContext = createContext<string | null>(null);

/**
 * A fileira de anexos como no Claude Code: imagem = cartão com a prévia (cantos arredondados), arquivo e
 * pasta = chip com ícone, nome e tamanho. Clicar numa imagem a amplia (`Lightbox`); num arquivo, abre no
 * painel de Arquivos (se for da pasta da conversa) ou revela no Finder. Com `onRemove`, cada item ganha o
 * "×" ao passar o mouse ou ao focar (no teclado, o botão fica alcançável).
 */
export function AttachmentStrip({ items, onRemove, cwd = null, className = "" }: {
  items: ShownAttachment[];
  onRemove?: (path: string) => void;
  /** A pasta da conversa, para decidir onde abrir um arquivo. */
  cwd?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const inherited = useContext(AttachCwdContext);
  const folder = cwd ?? inherited;
  if (items.length === 0) return null;
  const images = items.filter((i) => i.kind === "image");
  return (
    <>
      <ul aria-label={t("chat.attach.label")} className={`list-none m-0 p-0 flex flex-wrap gap-2 ${className}`}>
        {items.map((item) => (
          <li key={item.path} className="group relative">
            {item.kind === "image" ? (
              <ImageCard item={item} onOpen={() => setOpen(images.findIndex((i) => i.path === item.path))} />
            ) : (
              <button type="button" onClick={() => openAttachment(item.path, item.kind, folder)} title={item.path}
                aria-label={t("chat.attach.openFile", { name: item.name })}
                className="h-16 max-w-[220px] pl-2.5 pr-3 rounded-xl flex items-center gap-2 text-left bg-gray-100 dark:bg-white/[0.07] text-gray-800 dark:text-gray-100 hover:bg-gray-200/70 dark:hover:bg-white/[0.11]">
                {item.kind === "folder" ? <FolderIcon className="w-5 h-5 shrink-0 text-gray-500 dark:text-white/45" /> : <FilesIcon className="w-5 h-5 shrink-0 text-gray-500 dark:text-white/45" />}
                <span className="min-w-0">
                  <span className="block truncate text-chat-note font-medium">{item.name}</span>
                  <span className="block truncate text-chat-caption text-gray-500 dark:text-white/45">{item.kind === "folder" ? t("chat.attach.folder") : formatSize(item.size)}</span>
                </span>
              </button>
            )}
            {onRemove && (
              <button type="button" onClick={() => onRemove(item.path)} aria-label={t("chat.attach.remove", { name: item.name })} title={t("chat.attach.remove", { name: item.name })}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center bg-gray-800 text-white dark:bg-white dark:text-gray-900 shadow
                  opacity-0 group-hover:opacity-100 focus:opacity-100 group-focus-within:opacity-100">
                <XIcon className="w-3 h-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {open !== null && images.length > 0 && (
        <Lightbox images={images.map((i) => ({ path: i.path, name: i.name, preview: i.preview ?? null }))} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function ImageCard({ item, onOpen }: { item: ShownAttachment; onOpen: () => void }) {
  const { t } = useTranslation();
  const { src, missing } = useImagePreview(item.path, item.preview ?? null);
  return (
    <button type="button" onClick={onOpen} aria-label={t("chat.attach.zoom", { name: item.name })} title={item.name}
      className="block w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden bg-gray-100 dark:bg-white/[0.07] ring-1 ring-black/10 dark:ring-white/10 hover:ring-2 hover:ring-accent-500/60">
      {src ? (
        <img src={src} alt={item.name} className="w-full h-full object-cover" draggable={false} />
      ) : (
        <span className="w-full h-full flex items-center justify-center px-1 text-center text-chat-caption text-gray-400 dark:text-white/35">
          {missing ? t("chat.attach.missing") : ""}
        </span>
      )}
    </button>
  );
}
