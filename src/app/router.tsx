import { createHashRouter, type RouteObject } from "react-router-dom";
import { AppShell } from "@/app/AppShell";
import { HomePage } from "@/features/workspaces/HomePage";
import { RouteError } from "@/app/RouteError";
import { NotFound } from "@/app/NotFound";
import { ChildRouteError } from "@/app/PanelBoundary";

// Exportadas para o teste montar a mesma árvore com `createMemoryRouter`.
// Las páginas que no son la primera pantalla se cargan al entrar a ellas: antes iban todas
// en el chunk principal, que había que bajar y parsear entero antes de pintar nada.
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    // Erro da própria casca (a raiz): tela cheia. Erro de uma página não chega aqui: para no errorElement das filhas, logo abaixo.
    errorElement: <RouteError />,
    children: [
      {
        // Rota sem path: só agrupa as páginas. O erro de uma delas para aqui, dentro do `<Outlet>` da casca,
        // e a casca, o riel e as abas continuam montados (e os terminais, que não estão nesse Outlet).
        errorElement: <ChildRouteError />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "workspace", element: <></> },
          { path: "workspaces", lazy: () => import("@/features/workspaces/WorkspacesPage").then((m) => ({ Component: m.WorkspacesPage })) },
          { path: "skills", lazy: () => import("@/features/skills/SkillsPage").then((m) => ({ Component: m.SkillsPage })) },
          { path: "skills/:id", lazy: () => import("@/features/skills/SkillDetailPage").then((m) => ({ Component: m.SkillDetailPage })) },
          { path: "sessions", lazy: () => import("@/features/sessions/SessionsPage").then((m) => ({ Component: m.SessionsPage })) },
          { path: "fleet", lazy: () => import("@/features/runs/FleetPage").then((m) => ({ Component: m.FleetPage })) },
          { path: "missions", lazy: () => import("@/features/missions/MissionsPage").then((m) => ({ Component: m.MissionsPage })) },
          { path: "settings", lazy: () => import("@/features/settings/SettingsPage").then((m) => ({ Component: m.SettingsPage })) },
          { path: "squads", lazy: () => import("@/features/squads/SquadsPage").then((m) => ({ Component: m.SquadsPage })) },
          { path: "forge", lazy: () => import("@/features/forge/ForgePage").then((m) => ({ Component: m.ForgePage })) },
          { path: "marketplace", lazy: () => import("@/features/marketplace/MarketplacePage").then((m) => ({ Component: m.MarketplacePage })) },
          { path: "design/:id", lazy: () => import("@/features/design/DesignPage").then((m) => ({ Component: m.DesignPage })) },
          { path: "marketplace/registries", lazy: () => import("@/features/marketplace/RegistriesPage").then((m) => ({ Component: m.RegistriesPage })) },
          // Um caminho desconhecido mostra "Não encontrado" dentro da casca, nunca o erro de tela cheia.
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

export const router = createHashRouter(routes);
