import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimateSpin, Button, CopyIcon, Input } from "neogestify-ui-components";

import { ExternalIcon } from "@/app/icons";
import { AppDialog } from "@/shared/ui/AppDialog";

import { FORGE_KINDS, ForgeIcon, TOKEN_SCOPES, forgeLabel, tokenPageUrl } from "./forgeMeta";
import { forgeAddToken, forgeDeviceCancel, forgeDevicePoll, forgeDeviceStart, forgeOauthAvailable, forgeOauthClient, forgeOauthSetClient, type OauthClient } from "./ipc";
import { useForgeStore } from "./store";
import type { DeviceStart, ForgeKind, GitAccount } from "./types";

type Mode = "browser" | "token";

/** Onde se registra um aplicativo OAuth próprio em cada host com login pelo navegador. */
function newAppUrl(kind: ForgeKind): string | null {
  if (kind === "github") return "https://github.com/settings/applications/new";
  if (kind === "gitlab") return "https://gitlab.com/-/user_settings/applications";
  return null;
}

/** Um cartão de escolha (a forma de entrar): título, descrição e marca de selecionado. */
function MethodCard({ selected, title, description, onClick, disabled }: {
  selected: boolean; title: string; description: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onClick}
      className={`flex flex-1 flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:opacity-60 ${
        selected
          ? "bg-accent-500/12 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.6)]"
          : "bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.07] dark:hover:bg-white/[0.08]"}`}>
      <span className="text-[12.5px] font-semibold text-gray-900 dark:text-[#f5f5f7]">{title}</span>
      <span className="text-[11px] leading-[14px] text-gray-500 dark:text-white/55">{description}</span>
    </button>
  );
}

/**
 * Iniciar sesión en un host git: con el navegador (código de dispositivo, como VS Code) o
 * pegando un token.
 *
 * El navegador solo aparece donde la app tiene una aplicación OAuth registrada (github.com
 * y gitlab.com). Un GitLab propio, un GitHub Enterprise, Gitea o un host cualquiera van
 * con token: cada uno tendría su propia aplicación, que la app no puede tener registrada.
 *
 * El aplicativo OAuth é de quem o registrou: o nome que o host mostra ao autorizar é o do DONO. O padrão embutido é o do
 * projeto original; por isso aqui se vê qual está em uso e dá para trocar pelo próprio (Client ID).
 *
 * `host` fijo cuando se abre desde un repo ("iniciá sesión en gitlab.empresa.com"): ahí no
 * tiene sentido dejar cambiarlo. `kind` nulo cuando no se sabe qué es ese host (un GitHub
 * Enterprise no tiene nada en el nombre que lo delate): entonces se pregunta.
 */
export function AddGitAccountDialog({ kind: initialKind, host: fixedHost, onClose, onAdded }: {
  kind: ForgeKind | null;
  host?: string;
  onClose: () => void;
  onAdded?: (account: GitAccount) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ForgeKind>(initialKind ?? "github");
  const kinds = useForgeStore((s) => s.kinds);
  const load = useForgeStore((s) => s.load);
  const info = kinds.find((k) => k.kind === kind);
  const [host, setHost] = useState(fixedHost ?? info?.defaultHost ?? "");
  const [editHost, setEditHost] = useState(false);
  const [oauth, setOauth] = useState(false);
  const [mode, setMode] = useState<Mode>("token");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [app, setApp] = useState<OauthClient | null>(null);
  const [appOpen, setAppOpen] = useState(false);
  const [appDraft, setAppDraft] = useState("");
  const flowRef = useRef<string | null>(null);

  useEffect(() => { if (kinds.length === 0) load().catch(console.error); }, [kinds.length, load]);
  // Cambiar de tipo propone su host por defecto (el de un genérico queda vacío).
  const defaultHost = info?.defaultHost ?? "";
  useEffect(() => {
    if (!fixedHost) setHost(defaultHost);
  }, [defaultHost, fixedHost]);

  // Si el host escrito tiene navegador, se ofrece primero: es el camino sin copiar tokens.
  useEffect(() => {
    let alive = true;
    const h = host.trim();
    if (!h || kind === "other") { setOauth(false); setMode("token"); return; }
    forgeOauthAvailable(kind, h).then((ok) => {
      if (!alive) return;
      setOauth(ok);
      setMode(ok ? "browser" : "token");
    }).catch(() => alive && setOauth(false));
    return () => { alive = false; };
  }, [kind, host]);

  // Qual aplicativo OAuth este login usaria (só onde há login pelo navegador).
  useEffect(() => {
    let alive = true;
    if (!oauth) { setApp(null); return; }
    forgeOauthClient(kind).then((c) => { if (alive) setApp(c); }).catch(() => { if (alive) setApp(null); });
    return () => { alive = false; };
  }, [oauth, kind]);

  // Cerrar a mitad del login no deja un flujo esperando en el backend.
  useEffect(() => () => {
    if (flowRef.current) forgeDeviceCancel(flowRef.current).catch(() => {});
  }, []);

  const finish = async (account: GitAccount) => {
    flowRef.current = null;
    await load();
    onAdded?.(account);
    onClose();
  };

  const startBrowser = async () => {
    setBusy(true);
    setError("");
    try {
      const d = await forgeDeviceStart(kind, host.trim());
      setDevice(d);
      flowRef.current = d.flowId;
      await navigator.clipboard.writeText(d.userCode).then(() => setCopied(true)).catch(() => {});
      await openUrl(d.verificationUriComplete ?? d.verificationUri).catch(console.error);
      poll(d.flowId, d.interval);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const cancelBrowser = () => {
    if (flowRef.current) forgeDeviceCancel(flowRef.current).catch(() => {});
    flowRef.current = null;
    setDevice(null);
    setBusy(false);
    setCopied(false);
  };

  const poll = (flowId: string, interval: number) => {
    window.setTimeout(async () => {
      if (flowRef.current !== flowId) return;
      try {
        const r = await forgeDevicePoll(flowId);
        if (r.status === "pending") poll(flowId, r.interval);
        else if (r.status === "done") await finish(r.account);
        else {
          flowRef.current = null;
          setDevice(null);
          setBusy(false);
          setError(t(r.status === "expired" ? "forge.add.expired" : "forge.add.denied"));
        }
      } catch (e) {
        flowRef.current = null;
        setDevice(null);
        setBusy(false);
        setError(String(e));
      }
    }, interval * 1000);
  };

  const addToken = async () => {
    setBusy(true);
    setError("");
    try {
      await finish(await forgeAddToken(kind, host.trim(), token, kind === "other" ? username : null));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const saveApp = async (clientId: string | null) => {
    setError("");
    try {
      const next = await forgeOauthSetClient(kind, clientId);
      setApp(next);
      setAppDraft("");
      setAppOpen(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const label = forgeLabel(kind, t);
  const tokenUrl = host.trim() ? tokenPageUrl(kind, host.trim()) : null;
  const canToken = !!host.trim() && !!token.trim() && (kind !== "other" || !!username.trim());
  const appName = app?.custom ? t("forge.connect.app.custom") : kind === "github" ? t("forge.connect.app.builtin") : t("forge.connect.app.builtinGeneric");
  const registerUrl = newAppUrl(kind);
  const hostLocked = !!fixedHost || busy || !!device;

  return (
    <AppDialog
      title={t("forge.add.title", { provider: label })}
      icon={<ForgeIcon kind={kind} className="w-[15px] h-[15px] shrink-0 text-gray-600 dark:text-gray-300" />}
      onClose={() => { cancelBrowser(); onClose(); }}
      size="md"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" onClick={() => { cancelBrowser(); onClose(); }}>{t("btn.cancel")}</Button>
          {mode === "token" && (
            <Button variant="primary" disabled={busy || !canToken} onClick={addToken}>
              {busy ? t("forge.add.checking") : t("forge.add.save")}
            </Button>
          )}
          {mode === "browser" && !device && (
            <Button variant="primary" disabled={busy || !host.trim()} onClick={startBrowser}>
              {t("forge.add.continueBrowser", { host: host.trim() })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] leading-[18px] text-gray-600 dark:text-white/65">{t("forge.connect.subtitle")}</p>

        {initialKind === null && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="AddGitAccountDialog-select-1" className="text-[12px] font-medium text-gray-600 dark:text-gray-300">{t("forge.add.kind")}</label>
            <PopupSelect
              value={kind}
              onChange={(e) => { setKind(e.target.value as ForgeKind); setError(""); }}
              disabled={busy || !!device}
              id="AddGitAccountDialog-select-1">
              {FORGE_KINDS.map((k) => <option key={k} value={k}>{forgeLabel(k, t)}</option>)}
            </PopupSelect>
          </div>
        )}

        {/* O host: uma etiqueta com a ação de alterar; editável só quando não vem fixo do repositório. */}
        {editHost && !fixedHost ? (
          <Input
            label={t("forge.add.host")}
            value={host}
            onChange={(e) => { setHost(e.target.value); setError(""); }}
            placeholder={info?.defaultHost ?? "git.empresa.com"}
            variant="outline"
            disabled={hostLocked}
            helperText={kind === "other" ? t("forge.add.hostOther") : t("forge.add.hostHelper")}
          />
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">
            <span className="text-[11.5px] text-gray-500 dark:text-white/50">{t("forge.add.host")}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-gray-900 dark:text-[#f5f5f7]" title={host}>{host || "—"}</span>
            {!fixedHost && (
              <button type="button" disabled={hostLocked} onClick={() => setEditHost(true)}
                className="shrink-0 text-[11.5px] text-accent-600 hover:underline disabled:opacity-50 dark:text-accent-400">
                {t("forge.connect.hostChange")}
              </button>
            )}
          </div>
        )}

        {oauth && !device && (
          <div role="radiogroup" aria-label={t("forge.add.method")} className="flex gap-2">
            <MethodCard selected={mode === "browser"} title={t("forge.connect.method.browser")} description={t("forge.connect.method.browserDesc")}
              onClick={() => { setMode("browser"); setError(""); }} />
            <MethodCard selected={mode === "token"} title={t("forge.connect.method.token")} description={t("forge.connect.method.tokenDesc")}
              onClick={() => { setMode("token"); setError(""); }} />
          </div>
        )}

        {mode === "browser" && (
          device ? (
            <div className="flex flex-col gap-3">
              <ol className="flex flex-col gap-2.5">
                {[t("forge.connect.step1"), t("forge.connect.step2", { host: host.trim() }), t("forge.connect.step3")].map((text, i) => (
                  <li key={i} className="flex items-center gap-2.5 text-[12.5px] text-gray-700 dark:text-white/75">
                    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500/15 text-[11px] font-semibold text-accent-600 dark:text-accent-300">{i + 1}</span>
                    {text}
                  </li>
                ))}
              </ol>
              <div className="flex flex-col items-center gap-2 rounded-xl bg-black/[0.04] px-4 py-4 dark:bg-white/[0.05]">
                <Button variant="custom"
                  onClick={() => navigator.clipboard.writeText(device.userCode).then(() => setCopied(true)).catch(console.error)}
                  title={t("forge.add.copyCode")}
                  className="cc-t flex items-center gap-2 rounded-xl px-4 py-2 font-mono text-2xl font-bold tracking-[0.2em] text-gray-900 hover:bg-black/[0.06] dark:text-white dark:hover:bg-white/10"
                >
                  {device.userCode}
                  <CopyIcon className="h-4 w-4 opacity-50" />
                </Button>
                <span className="text-[11px] text-gray-500 dark:text-white/50">{copied ? t("forge.connect.codeHint") : t("forge.add.copyCode")}</span>
                <Button size="sm" variant="outline"
                  onClick={() => openUrl(device.verificationUriComplete ?? device.verificationUri).catch(console.error)}
                  className="flex items-center gap-1.5">
                  <ExternalIcon className="h-3 w-3" />
                  {t("forge.add.openAgain", { host: host.trim() })}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11.5px] text-gray-500 dark:text-white/50">
                  <AnimateSpin className="h-3 w-3" />
                  {t("forge.add.waiting")}
                </span>
                <button type="button" onClick={cancelBrowser} className="text-[11.5px] text-gray-500 hover:underline dark:text-white/50">{t("forge.connect.cancelFlow")}</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[11.5px] leading-[16px] text-gray-500 dark:text-white/55">{t("forge.add.browserHelp", { host: host.trim() })}</p>
              {kind === "github" && <p className="text-[11px] leading-[15px] text-gray-500 dark:text-white/45">{t("forge.connect.permissions")}</p>}
              {app && (
                <div className="flex flex-col gap-2 rounded-xl bg-black/[0.04] px-3 py-2.5 dark:bg-white/[0.05]">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="block text-[11px] text-gray-500 dark:text-white/50">{t("forge.connect.app.title")}</span>
                      <span className="block truncate text-[12.5px] font-medium text-gray-900 dark:text-[#f5f5f7]" title={app.clientId}>{appName}</span>
                    </div>
                    {app.custom && (
                      <button type="button" onClick={() => void saveApp(null)} className="shrink-0 text-[11.5px] text-gray-500 hover:underline dark:text-white/55">{t("forge.connect.app.reset")}</button>
                    )}
                    <button type="button" aria-expanded={appOpen} onClick={() => setAppOpen((v) => !v)}
                      className="shrink-0 text-[11.5px] text-accent-600 hover:underline dark:text-accent-400">
                      {app.custom ? t("forge.connect.app.change") : t("forge.connect.app.use")}
                    </button>
                  </div>
                  {appOpen && (
                    <div className="flex flex-col gap-2 border-t border-black/[0.08] pt-2 dark:border-white/10">
                      <p className="text-[11px] leading-[15px] text-gray-600 dark:text-white/60">{t("forge.connect.app.why", { host: host.trim() })}</p>
                      <p className="text-[11px] leading-[15px] text-gray-600 dark:text-white/60">{t("forge.connect.app.howTo")}</p>
                      {registerUrl && (
                        <button type="button" onClick={() => openUrl(registerUrl).catch(console.error)}
                          className="flex items-center gap-1 self-start text-[11.5px] text-accent-600 hover:underline dark:text-accent-400">
                          <ExternalIcon className="h-3 w-3" />
                          {t("forge.connect.app.open")}
                        </button>
                      )}
                      <Input label={t("forge.connect.app.clientId")} value={appDraft} onChange={(e) => setAppDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && appDraft.trim() && void saveApp(appDraft)}
                        placeholder={app.custom ? app.clientId : "Ov23li…"} variant="outline" />
                      <Button size="sm" variant="outline" className="self-start" disabled={!appDraft.trim()} onClick={() => void saveApp(appDraft)}>
                        {t("forge.connect.app.save")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        )}

        {mode === "token" && (
          <>
            {kind === "other" && (
              <Input
                label={t("forge.add.username")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                variant="outline"
                disabled={busy}
                helperText={t("forge.add.usernameHelper")}
              />
            )}
            <Input
              label={kind === "other" ? t("forge.add.password") : t("forge.add.tokenLabel")}
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && canToken && !busy && addToken()}
              variant="outline"
              disabled={busy}
              autoFocus={!oauth}
              helperText={TOKEN_SCOPES[kind] ? t("forge.add.scopes", { scopes: TOKEN_SCOPES[kind] }) : undefined}
            />
            {tokenUrl && (
              <Button variant="custom"
                onClick={() => openUrl(tokenUrl).catch(console.error)}
                className="self-start flex items-center gap-1 text-[11.5px] text-accent-600 dark:text-accent-400 hover:underline"
              >
                <ExternalIcon className="w-3 h-3" />
                {t("forge.add.createToken", { host: host.trim() })}
              </Button>
            )}
          </>
        )}

        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] break-words text-red-600 dark:text-red-300">{error}</p>}

        <p className="text-[10.5px] leading-relaxed text-gray-400 dark:text-white/35">{t("forge.connect.privacy")}</p>
      </div>
    </AppDialog>
  );
}
