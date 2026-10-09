import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

/**
 * O que aparece no lugar de uma página que quebrou ao renderizar. A casca (barra, trilho,
 * abas) continua de pé: sem isto o React Router mostrava a tela de erro padrão por cima de tudo
 * e a pessoa só tinha como fechar o app.
 */
export function RouteError() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const error = useRouteError();
  const detail = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);

  return (
    <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h2 className="text-[17px] font-semibold text-gray-900 dark:text-[#f5f5f7]">{t("app.routeError.title")}</h2>
      <p className="max-w-md text-[13px] text-gray-500 dark:text-white/55">{t("app.routeError.body")}</p>
      <code className="max-w-xl truncate rounded-md bg-black/[0.05] px-2.5 py-1 font-mono text-[11px] text-gray-600 dark:bg-white/[0.07] dark:text-white/60">{detail}</code>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => navigate("/")}>{t("app.routeError.home")}</Button>
        <Button variant="primary" onClick={() => window.location.reload()}>{t("app.routeError.reload")}</Button>
      </div>
    </div>
  );
}
