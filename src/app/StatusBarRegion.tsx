import { Suspense } from "react";

import { PanelBoundary } from "@/app/PanelBoundary";
import { lazyWithRetry } from "@/app/lazyWithRetry";
import { useStatusLoginStore } from "@/app/statusLoginStore";
import type { RepoInfo } from "@/features/explorer/types";

const StatusBar = lazyWithRetry(() => import("@/app/StatusBar").then((m) => ({ default: m.StatusBar })));
// Lazy: o diálogo carrega o terminal de login (xterm), e isso não pode entrar no entry da app.
const StatusBarLoginDialog = lazyWithRetry(() => import("@/app/StatusBarLoginDialog").then((m) => ({ default: m.StatusBarLoginDialog })));

/**
 * A barra de status e o diálogo do login de conta, cada um na sua fronteira, irmãos e não aninhados.
 * Se a barra quebra com o login aberto, só a barra cai no aviso: o `LoginTerminal` do diálogo (um PTY de
 * login) não é desmontado, porque não está dentro da fronteira da barra.
 */
export function StatusBarRegion({ repo }: { repo: RepoInfo | null }) {
  const loginAberto = useStatusLoginStore((s) => s.account !== null);
  return (
    <>
      <PanelBoundary name="status-bar">
        <Suspense fallback={null}>
          <StatusBar repo={repo} />
        </Suspense>
      </PanelBoundary>
      {loginAberto && (
        <PanelBoundary name="status-login">
          <Suspense fallback={null}>
            <StatusBarLoginDialog />
          </Suspense>
        </PanelBoundary>
      )}
    </>
  );
}
