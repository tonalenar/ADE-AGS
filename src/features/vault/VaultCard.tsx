import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { agentPaint } from "@/features/browser/agentPaint";
import { vaultAdd } from "./ipc";
import { useVaultPromptStore } from "./store";
import type { VaultConfirmPrompt, VaultRegisterPrompt } from "./types";

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Cartão do cofre de logins: cadastro sob demanda (`vault_request`) e confirmação de uso
 * (`browser_fill_login` no primeiro uso por par login/agente). Reaproveita o visual do cartão
 * de segredo (`AskDialog.tsx`); a senha vai direto ao comando Tauri `vault_add`, sem nunca
 * voltar ao agente.
 */
export function VaultCard() {
  const prompt = useVaultPromptStore((s) => s.prompts[0]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!prompt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [prompt?.id]);

  if (!prompt) return null;
  const remaining = prompt.expiresAt - now;
  if (prompt.mode === "register") {
    return <RegisterVaultDialog prompt={prompt} remaining={remaining} />;
  }
  return <ConfirmVaultDialog prompt={prompt} remaining={remaining} />;
}

function RegisterVaultDialog({ prompt, remaining }: { prompt: VaultRegisterPrompt; remaining: number }) {
  const { t } = useTranslation();
  const resolveRegister = useVaultPromptStore((s) => s.resolveRegister);
  const paint = agentPaint(prompt.fromId);
  const [origin, setOrigin] = useState(prompt.origin);
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(prompt.origin);
    setLabel("");
    setUsername("");
    setPassword("");
    setSaving(false);
    setError(null);
  }, [prompt.id, prompt.origin]);

  const canSave = origin.trim().length > 0 && username.trim().length > 0 && password.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const created = await vaultAdd(origin.trim(), username.trim(), label.trim(), password);
      setPassword("");
      resolveRegister(prompt.id, { id: created.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <AppDialog
      title={t("vault.card.register.title", { agent: prompt.from })}
      size="sm"
      onClose={() => resolveRegister(prompt.id, { declined: true })}
      closeOnEsc
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={() => resolveRegister(prompt.id, { declined: true })}>
            {t("vault.card.decline")}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void handleSave()}>
            {t("vault.card.register.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {prompt.reason && (
          <div className={`flex gap-2.5 px-3 py-2.5 rounded-lg ${paint.tint}`}>
            <span className={`w-[3px] shrink-0 rounded-full ${paint.strip}`} />
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-gray-800 dark:text-gray-200">
              {prompt.reason}
            </p>
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">{t("vault.field.origin")}</span>
          <Input
            type="text"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder={t("vault.field.originPlaceholder")}
            variant="outline"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">{t("vault.field.label")}</span>
          <Input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("vault.field.labelPlaceholder")}
            variant="outline"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">{t("vault.field.username")}</span>
          <Input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("vault.field.usernamePlaceholder")}
            variant="outline"
            autoFocus
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-gray-600 dark:text-white/65">{t("vault.field.password")}</span>
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) void handleSave();
            }}
            placeholder={t("vault.field.passwordPlaceholder")}
            variant="outline"
          />
        </label>

        {error && (
          <p className="text-[11.5px] text-rose-600 dark:text-rose-400">{error}</p>
        )}

        <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("vault.card.privacy")}
        </p>

        <p className="text-[11px] text-gray-400 dark:text-white/35">
          {t("ask.waiting", { time: formatRemaining(remaining) })}
        </p>
      </div>
    </AppDialog>
  );
}

function ConfirmVaultDialog({ prompt, remaining }: { prompt: VaultConfirmPrompt; remaining: number }) {
  const { t } = useTranslation();
  const resolveConfirm = useVaultPromptStore((s) => s.resolveConfirm);
  const paint = agentPaint(prompt.fromId);
  const [alwaysAllow, setAlwaysAllow] = useState(false);

  useEffect(() => {
    setAlwaysAllow(false);
  }, [prompt.id]);

  return (
    <AppDialog
      title={t("vault.card.confirm.title")}
      size="sm"
      onClose={() => resolveConfirm(prompt.id, "decline")}
      closeOnEsc
      footer={
        <>
          <Button variant="outline" onClick={() => resolveConfirm(prompt.id, "decline")}>
            {t("vault.card.decline")}
          </Button>
          <Button
            variant="primary"
            autoFocus
            onClick={() => resolveConfirm(prompt.id, alwaysAllow ? "always" : "once")}
          >
            {t("vault.card.confirm.allow")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className={`flex gap-2.5 px-3 py-2.5 rounded-lg ${paint.tint}`}>
          <span className={`w-[3px] shrink-0 rounded-full ${paint.strip}`} />
          <div className="flex flex-col gap-1 text-[12.5px] leading-relaxed text-gray-800 dark:text-gray-200">
            <p className="m-0">
              {t("vault.card.confirm.body", {
                agent: prompt.from,
                label: prompt.entry.label,
                origin: prompt.pageOrigin,
              })}
            </p>
            <p className="m-0 font-mono text-[11.5px] text-gray-600 dark:text-white/60">
              {prompt.entry.username}
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-gray-700 dark:text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
            className="rounded border-gray-300 dark:border-white/20"
          />
          <span>{t("vault.card.confirm.always")}</span>
        </label>

        <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("vault.card.privacy")}
        </p>

        <p className="text-[11px] text-gray-400 dark:text-white/35">
          {t("ask.waiting", { time: formatRemaining(remaining) })}
        </p>
      </div>
    </AppDialog>
  );
}
