import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "neogestify-ui-components";
import { AlertaToast } from "@/shared/ui/alerts";

import {
  antigravityOAuthAccounts, antigravityOAuthConfig, cancelAntigravityOAuth, configureAntigravityOAuth, pollAntigravityOAuth,
  startAntigravityOAuth, verifyAntigravityOAuth, type AntigravityOAuthAccount, type AntigravityOAuthConfig,
} from "./ipc";
import { accountNameLooksValid, clientIdLooksValid, clientSecretLooksValid, isGoogleAuthUrl, maskClientId } from "./oauthModel";

const field = "w-full h-8 px-2 rounded-md text-[12.5px] outline-none bg-white dark:bg-white/8 border border-gray-300 dark:border-white/15 focus:border-accent-400 text-gray-800 dark:text-gray-100";
const POLL_MS = 1500;

/**
 * Contas do Antigravity pelo OAuth PRÓPRIO do app: é o que deixa o painel de uso ler a cota (semanal/sessão
 * quando o serviço mandar). Não usa nem copia o login da CLI. O segredo do cliente vai direto para o cofre do
 * sistema e nunca volta para a tela. O cliente OAuth é SEU (tipo "aplicativo para computador" no Google Cloud).
 */
export function AntigravityOAuthSection() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AntigravityOAuthConfig | null>(null);
  const [accounts, setAccounts] = useState<AntigravityOAuthAccount[]>([]);
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [flow, setFlow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([antigravityOAuthConfig(), antigravityOAuthAccounts()]);
      setConfig(cfg);
      setAccounts(list);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const saveClient = async () => {
    if (!clientIdLooksValid(clientId) || !clientSecretLooksValid(secret)) return;
    setBusy(true);
    setError("");
    try {
      await configureAntigravityOAuth(clientId.trim(), secret);
      setSecret("");
      setClientId("");
      setEditing(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const poll = (flowId: string) => {
    timer.current = window.setTimeout(async () => {
      try {
        const progress = await pollAntigravityOAuth(flowId);
        if (progress.status === "pending") return poll(flowId);
        setFlow(null);
        if (progress.status === "connected") {
          setName("");
          AlertaToast(t("accounts.antigravity.oauth.title"), t("accounts.antigravity.oauth.connected", { email: progress.account.email }), "info", 6000);
        } else {
          setError(progress.message);
        }
        await load();
      } catch (e) {
        setFlow(null);
        setError(String(e));
      }
    }, POLL_MS);
  };

  const connect = async () => {
    if (!accountNameLooksValid(name) || flow) return;
    setError("");
    try {
      const login = await startAntigravityOAuth(name.trim());
      if (!isGoogleAuthUrl(login.authorizationUrl)) {
        await cancelAntigravityOAuth(login.flowId);
        setError(t("accounts.antigravity.oauth.badUrl"));
        return;
      }
      setFlow(login.flowId);
      await openUrl(login.authorizationUrl);
      poll(login.flowId);
    } catch (e) {
      setFlow(null);
      setError(String(e));
    }
  };

  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (flow) void cancelAntigravityOAuth(flow);
    setFlow(null);
  };

  const verify = async (account: AntigravityOAuthAccount) => {
    setBusy(true);
    try {
      await verifyAntigravityOAuth(account.id);
      AlertaToast(t("accounts.antigravity.oauth.title"), t("accounts.antigravity.oauth.verified", { email: account.email }), "info", 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!config) return error ? <p className="text-xs text-red-500">{error}</p> : null;
  const showForm = !config.configured || editing;

  return (
    <section className="flex flex-col gap-3 border-t border-gray-200 dark:border-white/10 pt-3" aria-label={t("accounts.antigravity.oauth.title")}>
      <h4 className="text-[13px] font-semibold">{t("accounts.antigravity.oauth.title")}</h4>
      <p className="text-xs text-gray-500">{t("accounts.antigravity.oauth.intro")}</p>

      {showForm ? (
        <div className="flex flex-col gap-2">
          <ol className="list-decimal pl-4 text-xs text-gray-500 flex flex-col gap-0.5">
            <li>{t("accounts.antigravity.oauth.step1")}</li>
            <li>{t("accounts.antigravity.oauth.step2")}</li>
            <li>{t("accounts.antigravity.oauth.step3")}</li>
          </ol>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium">{t("accounts.antigravity.oauth.clientId")}</span>
            <input className={field} value={clientId} autoComplete="off" spellCheck={false} placeholder="123456789-abc.apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium">{t("accounts.antigravity.oauth.clientSecret")}</span>
            <input className={field} type="password" value={secret} autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
          </label>
          <p className="text-[11px] text-gray-500">{t("accounts.antigravity.oauth.secretHint")}</p>
          <div className="flex gap-2">
            <Button disabled={busy || !clientIdLooksValid(clientId) || !clientSecretLooksValid(secret)} onClick={() => void saveClient()}>
              {t("accounts.antigravity.oauth.save")}
            </Button>
            {config.configured && <Button variant="outline" onClick={() => { setEditing(false); setSecret(""); setClientId(""); }}>{t("btn.cancel")}</Button>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500 flex items-center gap-2">
            <span>{t("accounts.antigravity.oauth.client")}: <code>{maskClientId(config.clientId ?? "")}</code></span>
            <Button variant="custom" className="text-accent-500 text-xs" onClick={() => setEditing(true)}>{t("accounts.antigravity.oauth.change")}</Button>
          </p>

          {accounts.length === 0 && <p className="text-xs text-gray-500">{t("accounts.antigravity.oauth.none")}</p>}
          {accounts.length > 0 && (
            <ul className="flex flex-col gap-1">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 rounded-md bg-gray-100/70 dark:bg-white/5 px-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate"><strong>{a.name}</strong> · {a.email}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className={a.connected ? "text-emerald-500" : "text-amber-500"}>
                      {a.connected ? t("accounts.antigravity.oauth.on") : t("accounts.antigravity.oauth.off")}
                    </span>
                    <Button variant="custom" className="text-accent-500" disabled={busy} onClick={() => void verify(a)}>{t("accounts.antigravity.oauth.verify")}</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 items-center">
            <input className={field} value={name} maxLength={100} disabled={!!flow} placeholder={t("accounts.antigravity.oauth.namePlaceholder")}
              aria-label={t("accounts.antigravity.oauth.namePlaceholder")} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }} />
            {flow ? (
              <Button variant="outline" onClick={cancel}>{t("btn.cancel")}</Button>
            ) : (
              <Button disabled={!accountNameLooksValid(name)} onClick={() => void connect()}>{t("accounts.antigravity.oauth.connect")}</Button>
            )}
          </div>
          {flow && <p className="text-xs text-gray-500" role="status">{t("accounts.antigravity.oauth.waiting")}</p>}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-500 whitespace-pre-wrap">{error}</p>}
    </section>
  );
}
