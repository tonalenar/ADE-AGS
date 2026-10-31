import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

/**
 * Uma rota que não existe. Aparece DENTRO da casca (a barra, o riel e as abas continuam de pé), no lugar
 * da página: um caminho desconhecido nunca derruba a tela inteira (isso é do `RouteError`, para erros de verdade).
 */
export function NotFound() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-3 bg-white p-8 text-center dark:bg-surface-deep">
      <h2 className="text-[17px] font-semibold text-gray-900 dark:text-[#f5f5f7]">{t("app.notFound.title")}</h2>
      <p className="max-w-md text-[13px] text-gray-500 dark:text-white/55">{t("app.notFound.body")}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => navigate(-1)}>{t("app.notFound.back")}</Button>
        <Button variant="primary" onClick={() => navigate("/")}>{t("app.notFound.home")}</Button>
      </div>
    </div>
  );
}
