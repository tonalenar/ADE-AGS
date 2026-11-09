import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import type { ChatProjectIcon } from "./chatProjectIdentity";

type IconMode = ChatProjectIcon["kind"] | "auto";
const MAX_IMAGE_BYTES = 256 * 1024;

export function ChatProjectIconDialog({ projectName, icon, onSave, onClose }: {
  projectName: string;
  icon: ChatProjectIcon | null;
  onSave: (icon: ChatProjectIcon | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<IconMode>(icon?.kind ?? "auto");
  const [value, setValue] = useState(icon?.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (mode === "auto") { onSave(null); return; }
    if (mode === "image" && !value.startsWith("data:image/")) { inputRef.current?.click(); return; }
    const normalized = value.trim().slice(0, mode === "emoji" ? 16 : mode === "monogram" ? 4 : 360_000);
    if (!normalized) { setError(t("chat.project.iconRequired")); return; }
    onSave({ kind: mode, value: normalized } as ChatProjectIcon);
  };
  const chooseImage = (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type) || file.size > MAX_IMAGE_BYTES) {
      setError(t("chat.project.iconImageInvalid"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError(t("chat.project.iconImageInvalid"));
    reader.onload = () => {
      if (typeof reader.result !== "string" || reader.result.length > 360_000) {
        setError(t("chat.project.iconImageInvalid"));
        return;
      }
      setMode("image");
      setValue(reader.result);
      setError(null);
    };
    reader.readAsDataURL(file);
  };
  return (
    <AppDialog title={t("chat.project.iconTitle", { project: projectName })} size="sm" onClose={onClose} closeOnEsc
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={save}>{t("btn.save")}</Button>
        </>
      )}>
      <div className="flex flex-col gap-4 text-chat-ui text-gray-800 dark:text-white/85">
        <div className="flex items-center gap-2">
          {(["auto", "emoji", "monogram", "image"] as const).map((choice) => (
            <button key={choice} type="button" aria-pressed={mode === choice} onClick={() => { setMode(choice); setError(null); }}
              className={`rounded-md px-2.5 py-1.5 text-chat-note ${mode === choice ? "bg-accent-100 text-accent-800 dark:bg-accent-500/20 dark:text-accent-200" : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-white/60 dark:hover:bg-white/10"}`}>
              {t(`chat.project.iconMode.${choice}`)}
            </button>
          ))}
        </div>
        {mode === "auto" && <p className="m-0 text-chat-note text-gray-500 dark:text-white/55">{t("chat.project.iconAutoDescription")}</p>}
        {mode === "emoji" && (
          <label className="flex flex-col gap-1.5 text-chat-note text-gray-600 dark:text-white/60">
            <span>{t("chat.project.iconEmojiLabel")}</span>
            <input autoFocus value={value} maxLength={16} onChange={(event) => { setValue(event.target.value); setError(null); }}
              className="h-9 px-2.5 rounded-md bg-white dark:bg-white/[0.06] border border-gray-300 dark:border-white/15 text-chat-ui text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-accent-500/60" />
          </label>
        )}
        {mode === "monogram" && (
          <label className="flex flex-col gap-1.5 text-chat-note text-gray-600 dark:text-white/60">
            <span>{t("chat.project.iconMonogramLabel")}</span>
            <input autoFocus value={value} maxLength={4} onChange={(event) => { setValue(event.target.value); setError(null); }}
              className="h-9 px-2.5 rounded-md bg-white dark:bg-white/[0.06] border border-gray-300 dark:border-white/15 text-chat-ui text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-accent-500/60" />
          </label>
        )}
        {mode === "image" && (
          <div className="flex flex-col gap-2">
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(event) => { chooseImage(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            <Button variant="outline" onClick={() => inputRef.current?.click()}>{t("chat.project.iconChooseImage")}</Button>
            {value.startsWith("data:image/") && <img src={value} alt="" className="h-14 w-14 rounded-xl object-cover" />}
            <p className="m-0 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.project.iconImageHint")}</p>
          </div>
        )}
        {error && <p role="alert" className="m-0 text-chat-note text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </AppDialog>
  );
}
