import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertaToast, Button, Input, TrashIcon } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import type { AccountCapableAgent } from "@/features/accounts/types";
import { STRATEGIES, poolRemove, poolSaveNew, usePools, type PoolStrategy } from "./pools";

/**
 * Los pools de una TUI: grupos con nombre de sus cuentas y la regla para repartir entre ellas
 * (la menos usada, una tras otra, o la principal con respaldo). Se piden como "pool:Nombre"
 * donde iría una cuenta. Solo tiene sentido con dos cuentas o más.
 */
export function PoolsSection({ agent }: { agent: AccountCapableAgent }) {
  const { t } = useTranslation();
  const created = useAccountsStore((s) => s.accounts);
  const pools = usePools(agent.agentId);
  const accounts = useMemo(() => created.filter((a) => a.agentId === agent.agentId), [created, agent.agentId]);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<(string | null)[]>([]);
  const [strategy, setStrategy] = useState<PoolStrategy>("least_used");
  const [armed, setArmed] = useState<string | null>(null);

  const options: { id: string | null; label: string }[] = [
    { id: null, label: t("accounts.system") },
    ...accounts.map((a) => ({ id: a.id, label: a.name })),
  ];
  const labelOf = (id: string | null) => options.find((o) => o.id === id)?.label ?? t("accounts.unavailable");
  const toggle = (id: string | null) =>
    setMembers((cur) => (cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]));

  const reset = () => {
    setAdding(false);
    setName("");
    setMembers([]);
    setStrategy("least_used");
  };

  const save = async () => {
    try {
      await poolSaveNew(name, agent.agentId, members, strategy);
      reset();
    } catch (e) {
      AlertaToast(t("accounts.pools.title"), String(e), "error", 6000);
    }
  };

  const remove = (id: string) => {
    if (armed !== id) return setArmed(id);
    setArmed(null);
    poolRemove(id).catch((e) => AlertaToast(t("accounts.pools.title"), String(e), "error", 6000));
  };

  // Con una sola cuenta (más la del sistema) ya hay dos para agrupar; sin ninguna creada, no.
  if (options.length < 2 && pools.length === 0) return null;

  return (
    <section className="mt-2 pt-3 border-t border-gray-200 dark:border-white/8">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/35">
          {t("accounts.pools.title")}
        </span>
        {!adding && options.length >= 2 && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>{t("accounts.pools.add")}</Button>
        )}
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-gray-500 dark:text-white/40">{t("accounts.pools.hint", { agent: agent.label })}</p>

      {pools.map((p) => (
        <div key={p.id} className="flex items-center gap-2 py-1.5 px-2 rounded-lg border border-gray-200 dark:border-white/8 mb-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[12.5px] font-medium text-gray-800 dark:text-gray-100">{p.name}</span>
              <code className="shrink-0 text-[10px] px-1.5 rounded bg-gray-100 dark:bg-white/8 text-gray-500 dark:text-gray-400">pool:{p.name}</code>
            </div>
            <div className="truncate text-[10.5px] text-gray-500 dark:text-white/40">
              {t(`accounts.pools.strategy.${p.strategy}`)} · {p.members.map(labelOf).join(" → ")}
            </div>
          </div>
          <Button variant="custom" onClick={() => remove(p.id)} aria-label={t("accounts.pools.delete")}
            className={`cc-t shrink-0 flex items-center justify-center h-6 rounded-md
              ${armed === p.id ? "px-2 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600" : "w-6 text-gray-400 hover:text-red-500"}`}>
            {armed === p.id ? t("accounts.pools.confirm") : <TrashIcon className="w-3.5 h-3.5" />}
          </Button>
        </div>
      ))}

      {adding && (
        <div className="flex flex-col gap-2 p-2.5 rounded-lg border border-accent-400/50 bg-accent-50/30 dark:bg-accent-500/5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("accounts.pools.namePlaceholder")} maxLength={30} />
          <div>
            <div className="mb-1 text-[10.5px] text-gray-500 dark:text-white/40">{t("accounts.pools.members")}</div>
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => {
                const at = members.indexOf(o.id);
                return (
                  <button key={o.id ?? "system"} type="button" onClick={() => toggle(o.id)} aria-pressed={at >= 0}
                    className={`cc-t px-2 h-6 rounded-md border text-[11px]
                      ${at >= 0
                        ? "border-accent-500 bg-accent-50 dark:bg-accent-500/10 text-accent-700 dark:text-accent-300"
                        : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-300"}`}>
                    {at >= 0 ? `${at + 1}. ` : ""}{o.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 text-[10px] text-gray-400 dark:text-white/30">{t("accounts.pools.order")}</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STRATEGIES.map((s) => (
              <button key={s} type="button" onClick={() => setStrategy(s)} aria-pressed={strategy === s}
                title={t(`accounts.pools.strategy.${s}.hint`)}
                className={`cc-t px-2 h-6 rounded-md border text-[11px]
                  ${strategy === s
                    ? "border-accent-500 bg-accent-50 dark:bg-accent-500/10 text-accent-700 dark:text-accent-300"
                    : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-300"}`}>
                {t(`accounts.pools.strategy.${s}`)}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={reset}>{t("btn.cancel")}</Button>
            <Button variant="primary" size="sm" disabled={!name.trim() || members.length < 2} onClick={() => void save()}>
              {t("accounts.pools.create")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
