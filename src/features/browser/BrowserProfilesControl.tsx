import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, Button, CheckIcon, CloseIcon, EditIcon, TrashIcon } from "neogestify-ui-components";

import { AccountCircleIcon } from "@/app/icons";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { browserProfileIsReferenced, DEFAULT_BROWSER_PROFILE_ID, createBrowserProfile, readBrowserProfiles, removeBrowserProfile, renameBrowserProfile, type BrowserProfile } from "./profiles";
import { realBrowserDeleteProfile } from "./realBrowser";
import { ToolButton } from "./toolbarButtons";

/** Seletor compacto dos perfis isolados do navegador da ADE. */
export function BrowserProfilesControl({ profileId, agentProfile, onSelect }: {
  profileId: string;
  agentProfile?: BrowserProfile;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const profileNameInputId = useId();
  const views = useViewTabsStore((state) => state.views);
  const portalViews = useViewTabsStore((state) => state.portalViews);
  const [profiles, setProfiles] = useState(readBrowserProfiles);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<BrowserProfile | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<BrowserProfile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const allViews = useMemo(() => [...views, ...portalViews], [views, portalViews]);
  const choices = useMemo(() => {
    const privateProfile: BrowserProfile = { id: "incognito", name: t("browser.profile.incognito") };
    return agentProfile
      ? [profiles[0]!, privateProfile, agentProfile, ...profiles.slice(1)]
      : [profiles[0]!, privateProfile, ...profiles.slice(1)];
  }, [profiles, agentProfile, t]);
  const current = choices.find((profile) => profile.id === profileId) ?? profiles[0]!;
  const label = current.id === DEFAULT_BROWSER_PROFILE_ID ? t("browser.profile.default") : current.name;

  const cancelEditing = useCallback(() => {
    setEditingProfile(null);
    setName("");
    setError(null);
  }, []);
  const closeMenu = useCallback(() => {
    if (deleteBusy) return;
    setOpen(false);
    cancelEditing();
    setDeletingProfile(null);
    setDeleteError(null);
  }, [cancelEditing, deleteBusy]);

  useEffect(() => {
    if (open) setProfiles(readBrowserProfiles());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open, closeMenu]);

  const addProfile = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const profile = editingProfile
        ? renameBrowserProfile(editingProfile.id, name)
        : createBrowserProfile(name);
      const next = readBrowserProfiles();
      setProfiles(next);
      setName("");
      setEditingProfile(null);
      setOpen(false);
      if (!editingProfile) onSelect(profile.id);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "storage";
      setError(code === "duplicate" ? t("browser.profile.duplicate")
        : code === "limit" ? t("browser.profile.limit")
          : code === "empty" ? t("browser.profile.nameRequired") : t("browser.profile.saveError"));
    }
  };

  const confirmDeleteProfile = async () => {
    if (!deletingProfile) return;
    setDeleteError(null);
    if (browserProfileIsReferenced(deletingProfile.id, allViews)) {
      setDeleteError(t("browser.profile.inUse"));
      return;
    }
    setDeleteBusy(true);
    try {
      await realBrowserDeleteProfile(deletingProfile.id);
      removeBrowserProfile(deletingProfile.id);
      setProfiles(readBrowserProfiles());
      setDeletingProfile(null);
      setDeleteError(null);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : String(reason);
      setDeleteError(code.includes("browser_profile_in_use") ? t("browser.profile.inUse")
        : code === "missing" || code === "storage" ? t("browser.profile.deleteSaveError")
          : t("browser.profile.deleteError"));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div ref={root} className="relative shrink-0">
      <ToolButton label={t("browser.profile.current", { name: label })} active={open} onClick={() => open ? closeMenu() : setOpen(true)}>
        <AccountCircleIcon className="w-4 h-4" />
      </ToolButton>
      {open && (
        <div
          data-over-webview
          role="dialog"
          aria-label={t("browser.profile.title")}
          className="absolute top-full right-0 z-[10000] mt-1 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-gray-900"
        >
          {deletingProfile ? (
            <div role="alertdialog" aria-label={t("browser.profile.deleteTitle", { name: deletingProfile.name })} className="p-2">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t("browser.profile.deleteTitle", { name: deletingProfile.name })}
              </p>
              <p className="mt-2 text-xs leading-4 text-gray-600 dark:text-gray-300">
                {t("browser.profile.deleteBody", { name: deletingProfile.name })}
              </p>
              {deleteError && <p role="alert" className="mt-2 text-xs leading-4 text-red-600 dark:text-red-400">{deleteError}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="outline" disabled={deleteBusy} onClick={() => { setDeletingProfile(null); setDeleteError(null); }}>
                  {t("btn.cancel")}
                </Button>
                <Button variant="danger" disabled={deleteBusy} onClick={confirmDeleteProfile}>
                  {t(deleteBusy ? "browser.profile.deleteBusy" : "browser.profile.deleteConfirm")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="px-2 pb-2 pt-1 text-xs font-semibold text-gray-500 dark:text-gray-400">
                {t("browser.profile.title")}
              </div>
              <div role="group" aria-label={t("browser.profile.title")} className="max-h-48 overflow-y-auto">
                {choices.map((profile: BrowserProfile) => {
                  const selected = profile.id === profileId;
                  const profileName = profile.id === DEFAULT_BROWSER_PROFILE_ID ? t("browser.profile.default") : profile.name;
                  const profileInUse = profile.id.startsWith("profile-") && browserProfileIsReferenced(profile.id, allViews);
                  return (
                    <div key={profile.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => { onSelect(profile.id); closeMenu(); }}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-white/10"
                      >
                        <span className="min-w-0 flex-1 truncate">{profileName}</span>
                        {selected && <CheckIcon className="h-4 w-4 shrink-0 text-accent-600 dark:text-accent-300" />}
                      </button>
                      {profile.id.startsWith("profile-") && (
                        <>
                          <ToolButton
                            label={t("browser.profile.rename", { name: profile.name })}
                            onClick={() => { setEditingProfile(profile); setName(profile.name); setError(null); }}
                          >
                            <EditIcon className="h-3.5 w-3.5" />
                          </ToolButton>
                          <ToolButton
                            label={profileInUse ? t("browser.profile.inUse") : t("browser.profile.delete", { name: profile.name })}
                            disabled={profileInUse}
                            onClick={() => {
                              setEditingProfile(null);
                              setName("");
                              setDeleteError(null);
                              setDeletingProfile(profile);
                            }}
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </ToolButton>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <form onSubmit={addProfile} className="mt-2 border-t border-gray-200 pt-2 dark:border-white/10">
                <label className="sr-only" htmlFor={profileNameInputId}>{t("browser.profile.name")}</label>
                <div className="flex items-center gap-1.5">
                  <input
                    id={profileNameInputId}
                    value={name}
                    maxLength={48}
                    onChange={(event) => { setName(event.target.value); setError(null); }}
                    placeholder={t(editingProfile ? "browser.profile.renamePlaceholder" : "browser.profile.namePlaceholder")}
                    className="cc-t min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent-500 dark:border-white/15 dark:bg-gray-950 dark:text-gray-100 dark:placeholder:text-white/35"
                  />
                  <button
                    type="submit"
                    aria-label={t(editingProfile ? "browser.profile.saveName" : "browser.profile.create")}
                    disabled={!name.trim()}
                    className="cc-t flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-45"
                  >
                    {editingProfile ? <CheckIcon className="h-4 w-4" /> : <AddIcon className="h-4 w-4" />}
                  </button>
                  {editingProfile && (
                    <button
                      type="button"
                      aria-label={t("browser.profile.cancelRename")}
                      onClick={cancelEditing}
                      className="cc-t flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
                    >
                      <CloseIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="px-1 pt-1.5 text-[11px] leading-4 text-gray-500 dark:text-gray-400">
                  {error ?? t("browser.profile.isolatedHint")}
                </p>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
