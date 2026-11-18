import { Component, createContext, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate, useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

interface PanelBoundaryProps {
  /** Nome do painel: é o que diz, no log, qual deles quebrou. */
  name: string;
  children: ReactNode;
  /** Opcional: o que mostrar no lugar do painel quebrado. Sem ele, o aviso com "Tentar de novo". */
  fallback?: ReactNode;
}

interface PanelBoundaryState {
  failed: boolean;
  error: unknown;
  /** Quantas vezes o painel foi tentado de novo. Cada tentativa é um valor novo de `RetryAttemptContext`. */
  attempt: number;
}

/**
 * O número da tentativa do boundary mais próximo. Um `lazyWithRetry` usa isso para criar um `lazy` novo a
 * cada "Tentar de novo": o `React.lazy` guarda a rejeição, então sem um lazy novo o chunk não é buscado de novo.
 */
export const RetryAttemptContext = createContext(0);

/** Texto curto do erro, para o aviso não esconder o que aconteceu. */
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cerca um painel da casca. Se ele quebra ao renderizar, só ele some, no lugar aparece um aviso com
 * "Tentar de novo"; o resto da casca continua montado.
 *
 * NÃO envolva `EditorArea` nem nada que contenha `<Terminal>`: este boundary, ao trocar os filhos,
 * desmonta o que estiver dentro, e desmontar `<Terminal>` mata o PTY do agente.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  state: PanelBoundaryState = { failed: false, error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<PanelBoundaryState> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // O erro não é engolido: fica no console com o nome do painel, para depurar.
    console.error(`[PanelBoundary:${this.props.name}]`, error, info.componentStack);
  }

  // Tentar de novo: volta a renderizar os filhos com uma tentativa nova (ver `RetryAttemptContext`).
  private retry = () => {
    this.setState((s) => ({ failed: false, error: null, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return <PanelErrorView detail={errorDetail(this.state.error)} onRetry={this.retry} />;
    }
    return <RetryAttemptContext value={this.state.attempt}>{this.props.children}</RetryAttemptContext>;
  }
}

/**
 * `errorElement` das rotas filhas. Renderiza dentro do `<Outlet>` da casca, então a barra, o riel e as
 * abas continuam de pé. Quem quebra é só a página, e o `RouteError` de tela cheia fica para a raiz.
 */
export function ChildRouteError() {
  const error = useRouteError();
  const location = useLocation();
  const navigate = useNavigate();

  // "Tentar de novo" navega para o mesmo caminho, sem recarregar a janela (recarregar mataria os
  // terminais). Um `location` novo faz o boundary do React Router renderizar a rota filha de novo.
  const retry = () => {
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true });
  };

  return <PanelErrorView detail={errorDetail(error)} onRetry={retry} page />;
}

/** Aviso mostrado no lugar de um painel ou de uma página que quebrou. */
function PanelErrorView({ detail, onRetry, page = false }: { detail: string; onRetry: () => void; page?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      // Página inteira: fundo sólido, porque cobre o conteúdo. Painel: transparente, para se misturar à casca.
      // `pointer-events-auto`: o aviso pode cair dentro de um contêiner que deixa o clique passar (a grade de
      // painéis do EditorArea); sem isto o botão "Tentar de novo" ficaria inclicável.
      className={`pointer-events-auto flex h-full min-h-24 w-full flex-col items-center justify-center gap-3 p-6 text-center${page ? " bg-white dark:bg-surface-deep" : ""}`}
    >
      <h2 className="text-[15px] font-semibold text-gray-900 dark:text-white">{t("app.panelError.title")}</h2>
      <code className="max-w-md truncate rounded-md bg-black/[0.05] px-2.5 py-1 font-mono text-[11px] text-gray-600 dark:bg-white/[0.07] dark:text-white/60" title={detail}>{detail}</code>
      <Button variant="primary" onClick={onRetry}>{t("app.panelError.retry")}</Button>
    </div>
  );
}
