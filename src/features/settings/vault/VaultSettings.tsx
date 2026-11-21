import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";
import {
  vaultAdd,
  vaultList,
  vaultRemove,
  vaultRevokeAgent,
  vaultUpdate,
} from "@/features/vault/ipc";
import type { VaultEntry } from "@/features/vault/types";

/**
 * Configurações → Cofre de logins.
 *
 * Lista, cadastra, edita usuário/rótulo, troca senha, apaga logins e revoga
 * permissões "sempre permitir" por agente. A senha nunca é exibida nem lida aqui.
 */
export function VaultSettings() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editLabel, setEditLabel] = useState("");

  const [passwordEditId, setPasswordEditId] = useState<string | null>(null);
  const [replacementPassword, setReplacementPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await vaultList();
      setEntries(list);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    if (!newOrigin.trim() || !newUsername.trim() || !newPassword) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await vaultAdd(
        newOrigin.trim(),
        newUsername.trim(),
        newLabel.trim(),
        newPassword,
      );
      setEntries((prev) => [...prev, created]);
      setNewOrigin("");
      setNewLabel("");
      setNewUsername("");
      setNewPassword("");
      setAdding(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (entry: VaultEntry) => {
    setPasswordEditId(null);
    setReplacementPassword("");
    setEditingId(entry.id);
    setEditUsername(entry.username);
    setEditLabel(entry.label);
  };

  const handleSaveEdit = async (id: string) => {
    if (!editUsername.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await vaultUpdate(id, {
        username: editUsername.trim(),
        label: editLabel.trim(),
      });
      setEntries((prev) => prev.map((item) => (item.id === id ? updated : item)));
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const startPasswordChange = (id: string) => {
    setEditingId(null);
    setPasswordEditId(id);
    setReplacementPassword("");
  };

  const handleSavePassword = async (id: string) => {
    if (!replacementPassword) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await vaultUpdate(id, { password: replacementPassword });
      setEntries((prev) => prev.map((item) => (item.id === id ? updated : item)));
      setReplacementPassword("");
      setPasswordEditId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (id: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await vaultRemove(id);
      setEntries((prev) => prev.filter((item) => item.id !== id));
      if (editingId === id) setEditingId(null);
      if (passwordEditId === id) {
        setPasswordEditId(null);
        setReplacementPassword("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevokeAgent = async (id: string, agent: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const updated = await vaultRevokeAgent(id, agent);
      setEntries((prev) => prev.map((item) => (item.id === id ? updated : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.vault")}
      description={t("settings.vault.desc")}
      action={
        <Button
          variant="primary"
          size="sm"
          data-testid="vault-add-toggle"
          onClick={() => setAdding((open) => !open)}
        >
          {adding ? t("settings.vault.cancel") : t("settings.vault.add")}
        </Button>
      }
    >
      {error && (
        <p className="m-0 text-[12px] text-rose-600 dark:text-rose-400" role="alert">
          {error}
        </p>
      )}

      {adding && (
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">
                {t("vault.field.origin")}
              </span>
              <Input
                type="text"
                value={newOrigin}
                onChange={(e) => setNewOrigin(e.target.value)}
                placeholder={t("vault.field.originPlaceholder")}
                variant="outline"
                data-testid="vault-add-origin"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">
                {t("vault.field.label")}
              </span>
              <Input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("vault.field.labelPlaceholder")}
                variant="outline"
                data-testid="vault-add-label"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">
                {t("vault.field.username")}
              </span>
              <Input
                type="text"
                autoComplete="username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t("vault.field.usernamePlaceholder")}
                variant="outline"
                data-testid="vault-add-username"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">
                {t("vault.field.password")}
              </span>
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t("vault.field.passwordPlaceholder")}
                variant="outline"
                data-testid="vault-add-password"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setAdding(false);
                  setNewPassword("");
                }}
              >
                {t("settings.vault.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={submitting || !newOrigin.trim() || !newUsername.trim() || !newPassword}
                data-testid="vault-add-submit"
                onClick={() => void handleAdd()}
              >
                {t("settings.vault.save")}
              </Button>
            </div>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup>
        {loading ? (
          <p className="m-0 px-4 py-3.5 text-[12.5px] text-gray-500 dark:text-white/50">
            {t("settings.vault.loading")}
          </p>
        ) : entries.length === 0 ? (
          <p className="m-0 px-4 py-3.5 text-[12.5px] text-gray-500 dark:text-white/50">
            {t("settings.vault.empty")}
          </p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13.5px] font-medium text-gray-900 dark:text-white">
                    {entry.label}
                  </p>
                  <p className="m-0 truncate font-mono text-[11.5px] text-gray-500 dark:text-white/55">
                    {entry.origin}
                  </p>
                  <p className="m-0 mt-0.5 truncate text-[12px] text-gray-700 dark:text-gray-300">
                    {entry.username}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    data-testid={`vault-edit-${entry.id}`}
                    onClick={() => startEdit(entry)}
                  >
                    {t("settings.vault.edit")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    data-testid={`vault-change-pw-${entry.id}`}
                    onClick={() => startPasswordChange(entry.id)}
                  >
                    {t("settings.vault.changePassword")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    data-testid={`vault-remove-${entry.id}`}
                    onClick={() => void handleRemove(entry.id)}
                  >
                    {t("settings.vault.remove")}
                  </Button>
                </div>
              </div>

              {entry.allowed_agents.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-gray-500 dark:text-white/45">
                    {t("settings.vault.allowedAgents")}
                  </span>
                  {entry.allowed_agents.map((agent) => (
                    <span
                      key={agent}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-white/10 px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-300"
                    >
                      <span className="font-mono">{agent}</span>
                      <button
                        type="button"
                        disabled={submitting}
                        data-testid={`vault-revoke-${entry.id}-${agent}`}
                        onClick={() => void handleRevokeAgent(entry.id, agent)}
                        className="text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                      >
                        {t("settings.vault.revoke")}
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {editingId === entry.id && (
                <div className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-white/10 p-3">
                  <Input
                    type="text"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder={t("vault.field.labelPlaceholder")}
                    variant="outline"
                    data-testid={`vault-edit-label-${entry.id}`}
                  />
                  <Input
                    type="text"
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    placeholder={t("vault.field.usernamePlaceholder")}
                    variant="outline"
                    data-testid={`vault-edit-user-${entry.id}`}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                      {t("settings.vault.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={submitting || !editUsername.trim()}
                      data-testid={`vault-save-edit-${entry.id}`}
                      onClick={() => void handleSaveEdit(entry.id)}
                    >
                      {t("settings.vault.save")}
                    </Button>
                  </div>
                </div>
              )}

              {passwordEditId === entry.id && (
                <div className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-white/10 p-3">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={replacementPassword}
                    onChange={(e) => setReplacementPassword(e.target.value)}
                    placeholder={t("settings.vault.newPasswordPlaceholder")}
                    variant="outline"
                    data-testid={`vault-new-pw-${entry.id}`}
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPasswordEditId(null);
                        setReplacementPassword("");
                      }}
                    >
                      {t("settings.vault.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={submitting || !replacementPassword}
                      data-testid={`vault-save-pw-${entry.id}`}
                      onClick={() => void handleSavePassword(entry.id)}
                    >
                      {t("settings.vault.savePassword")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </SettingsGroup>

      <p className="m-0 text-[11.5px] leading-relaxed text-gray-500 dark:text-white/45">
        {t("vault.card.privacy")}
      </p>
    </SettingsSection>
  );
}
