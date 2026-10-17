/**
 * A espera por ESTADO, não por tempo (achado E1 do plano v2).
 *
 * Antes, depois de cada ação o runtime esperava um tempo fixo (60–350 ms no piloto) e a página nova só era esperada
 * quando o resultado dizia `navigated`. Uma busca que leva 8 s (a Amazon) terminava o passo com a página antiga ainda
 * na tela. Aqui a pergunta é outra: o que está acontecendo AGORA? Há navegação em curso? Há pedidos (fetch/XHR) que
 * começaram depois da ação e não terminaram? O documento ainda está carregando? O DOM mexeu há pouco?
 *
 * `settle` termina quando NADA disso está pendente: sem navegação, rede ociosa por `netIdleMs`, DOM quieto por `quietMs`.
 * O teto depende do que se viu: sem nada pendente é o curto de sempre (`maxMs`); se algo ficou pendente, sobe para
 * `pendingMaxMs` (≈ 12 s numa busca). O relatório diz o que esperou.
 *
 * Os pedidos que JÁ estavam em voo quando a espera começou (um long-poll, uma telemetria) são ignorados: senão uma página
 * com um pedido eterno faria toda ação esperar o teto.
 *
 * Tudo que toca o ambiente (relógio, temporizador, DOM) entra por `env`, para testar com relógio falso.
 */

export interface ActivityEnv {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** `document.readyState`. */
  readyState: () => string;
  /** Avisa a cada mudança no DOM; devolve como parar de avisar. */
  watchDom: (onChange: () => void) => () => void;
}

export interface SettleOptions {
  /** Teto quando nada ficou pendente. */
  maxMs: number;
  /** O DOM sem mudar por este tempo. */
  quietMs: number;
  /** Nenhum pedido novo começando nem terminando por este tempo. */
  netIdleMs: number;
  /** Teto quando navegação, pedidos ou o carregamento do documento ficaram pendentes. */
  pendingMaxMs: number;
  /** Tempo mínimo antes de poder terminar (dá a uma tarefa seguinte, como o envio de um formulário, a chance de começar). */
  minMs: number;
  /**
   * Os pedidos que já existiam quando a AÇÃO começou e que não contam (um long-poll). Tem de ser marcado antes da ação
   * (`liveIds()`), não no início da espera: um clique dispara o `fetch` de forma síncrona, antes de a espera começar.
   * Sem isso, todos os pedidos em voo contam.
   */
  baseline?: ReadonlySet<number>;
}

export interface SettleReport {
  waitedMs: number;
  /** `quiet` = assentou; `limit` = parou no teto. */
  reason: "quiet" | "limit";
  /** Houve navegação pendente em algum momento. */
  navigation: boolean;
  /** O máximo de pedidos novos pendentes ao mesmo tempo. */
  requests: number;
  /** O documento estava em `loading` em algum momento. */
  loading: boolean;
  /** O teto que valeu (curto ou o de pendências). */
  capMs: number;
  /** Algo ficou pendente em algum momento (o que sobe o teto). */
  sawPending: boolean;
  /** No fim, ainda havia algo pendente (só com `reason: "limit"`). */
  stillPending: boolean;
}

/** Uma navegação anunciada que nunca chegou a trocar o documento (um download, um clique cancelado) deixa de contar. */
export const NAV_STALE_MS = 15_000;
const TICK_MS = 25;

export interface Activity {
  /** Começa a contar um pedido; devolve o que o termina (idempotente). */
  begin: () => () => void;
  /** Pedidos em voo agora, de qualquer origem. */
  size: () => number;
  /** Os ids dos pedidos em voo agora: a `baseline` de uma espera. */
  liveIds: () => Set<number>;
  /** Há quanto tempo (ms) nenhum pedido começou nem terminou; `Infinity` se a página nunca fez nenhum. */
  quietFor: () => number;
  markNavigation: () => void;
  clearNavigation: () => void;
  navigating: () => boolean;
  settle: (options: SettleOptions) => Promise<SettleReport>;
}

export function createActivity(env: ActivityEnv): Activity {
  const live = new Set<number>();
  const listeners = new Set<(id: number) => void>();
  let seq = 0;
  let navAt: number | null = null;
  let lastEventAt: number | null = null;

  const navigating = (): boolean => navAt !== null && env.now() - navAt < NAV_STALE_MS;

  function begin(): () => void {
    const id = ++seq;
    live.add(id);
    lastEventAt = env.now();
    for (const listener of listeners) listener(id);
    return () => {
      if (!live.delete(id)) return;
      lastEventAt = env.now();
      for (const listener of listeners) listener(id);
    };
  }

  function settle(options: SettleOptions): Promise<SettleReport> {
    return new Promise((done) => {
      const started = env.now();
      // Os pedidos de antes da ação não contam.
      const ambient = options.baseline ?? new Set<number>();
      let lastDom = started;
      let lastNet = started;
      let sawNav = false;
      let sawLoading = false;
      let maxRequests = 0;
      let sawPending = false;
      let timer: unknown = null;
      const onNet = (id: number) => { if (!ambient.has(id)) lastNet = env.now(); };
      listeners.add(onNet);
      const stopDom = env.watchDom(() => { lastDom = env.now(); });

      const pendingRequests = (): number => {
        let n = 0;
        for (const id of live) if (!ambient.has(id)) n += 1;
        return n;
      };

      const finish = (reason: SettleReport["reason"], capMs: number, stillPending: boolean): void => {
        listeners.delete(onNet);
        stopDom();
        if (timer !== null) env.clearTimer(timer);
        done({
          waitedMs: env.now() - started, reason, navigation: sawNav, requests: maxRequests, loading: sawLoading, capMs,
          sawPending, stillPending,
        });
      };

      const tick = (): void => {
        timer = null;
        const now = env.now();
        const requests = pendingRequests();
        const nav = navigating();
        const loading = env.readyState() === "loading";
        if (requests > 0 || nav || loading) {
          sawPending = true;
          maxRequests = Math.max(maxRequests, requests);
          sawNav ||= nav;
          sawLoading ||= loading;
        }
        const capMs = sawPending ? Math.max(options.pendingMaxMs, options.maxMs) : options.maxMs;
        const elapsed = now - started;
        const pending = requests > 0 || nav || loading;
        if (!pending && elapsed >= options.minMs && now - lastDom >= options.quietMs && now - lastNet >= options.netIdleMs) {
          finish("quiet", capMs, false);
          return;
        }
        if (elapsed >= capMs) {
          finish("limit", capMs, pending);
          return;
        }
        timer = env.setTimer(tick, TICK_MS);
      };
      tick();
    });
  }

  const quietFor = (): number => (lastEventAt === null ? Infinity : env.now() - lastEventAt);

  return { begin, size: () => live.size, liveIds: () => new Set(live), quietFor, markNavigation: () => { navAt = env.now(); }, clearNavigation: () => { navAt = null; }, navigating, settle };
}

/**
 * O que a espera diz de si, para o resultado do comando e o relatório do `act`. `null` = foi rápido e não havia nada
 * pendente: não vale uma linha.
 */
export function describeWait(report: SettleReport): string | null {
  if (!report.sawPending && report.waitedMs < 500) return null;
  const secs = `${(report.waitedMs / 1000).toFixed(1).replace(".", ",")} s`;
  const seen: string[] = [];
  if (report.navigation) seen.push("navegação pendente");
  if (report.requests > 0) seen.push(`${report.requests} ${report.requests === 1 ? "pedido" : "pedidos"} de rede`);
  if (report.loading) seen.push("documento carregando");
  const what = seen.length > 0 ? seen.join(" + ") : "DOM mudando";
  const end = report.reason === "quiet"
    ? "assentou"
    : report.stillPending
      ? `parou no teto de ${Math.round(report.capMs / 1000)} s com a página ainda carregando`
      : `parou no teto de ${Math.round(report.capMs / 1000)} s`;
  return `esperou ${secs} (${what}) — ${end}`;
}
