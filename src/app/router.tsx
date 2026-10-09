import { createHashRouter } from "react-router-dom";
import { AppShell } from "@/app/AppShell";
import { HomePage } from "@/features/workspaces/HomePage";
import { RouteError } from "@/app/RouteError";

// Las páginas que no son la primera pantalla se cargan al entrar a ellas: antes iban todas
// en el chunk principal, que había que bajar y parsear entero antes de pintar nada.
export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    // Uma página que quebra mostra o erro dentro da casca, não derruba o app inteiro.
    errorElement: <RouteError />,
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
      { path: "marketplace/registries", lazy: () => import("@/features/marketplace/RegistriesPage").then((m) => ({ Component: m.RegistriesPage })) },
    ],
  },
]);
