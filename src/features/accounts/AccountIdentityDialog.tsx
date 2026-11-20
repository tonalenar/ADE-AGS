import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { AccountBadge } from "@/features/accounts/AccountBadge";
import { AccountColorPicker } from "@/features/accounts/AccountColorPicker";
import { accountDisplayLabel, isAccountColorToken } from "@/features/accounts/accountIdentity";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { AppDialog } from "@/shared/ui/AppDialog";

/**
 * Renomear e colorir uma conta (inclusive a principal). Só mexe no que a pessoa vê: a pasta
 * do perfil e o login ficam como estão. Nome vazio volta ao padrão.
 */
export function AccountIdentityDialog({ account, onClose }: { account: AgentAccount; onClose: () => void }) {
  const { t } = useTranslation();
  const setIdentity = useAccountsStore((s) => s.setIdentity);
  const [name, setName] = useState(account.displayName ?? "");
  const [color, setColor] = useState<string | null>(isAccountColorToken(account.accentColor) ? account.accentColor : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const principal = t("accounts.principalName");
  const preview = accountDisplayLabel({ ...account, displayName: name }, principal);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setIdentity(account.id, name.trim() || null, color);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("settings.accounts.identity.title", { name: accountDisplayLabel(account, principal) })}
      onClose={onClose}
      size="sm"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={save}>{t("settings.accounts.identity.save")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <AccountBadge label={preview} accentColor={color} size="md" />
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">{preview}</span>
        </div>
        <Input
          label={t("settings.accounts.identity.displayName")}
          value={name}
          maxLength={40}
          onChange={(e) => { setName(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(); }}
          placeholder={accountDisplayLabel({ ...account, displayName: null }, principal)}
          variant="outline"
          autoFocus
          helperText={t("settings.accounts.identity.displayNameHelper")}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-gray-700 dark:text-gray-300">
            {t("settings.accounts.identity.color")}
          </span>
          <AccountColorPicker value={color} onChange={setColor} label={t("settings.accounts.identity.color")} />
        </div>
        {error && <p role="alert" className="text-[11.5px] text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </AppDialog>
  );
}
