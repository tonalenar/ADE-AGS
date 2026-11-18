import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { accountLoginCommand } from "@/features/accounts/login";
import { AppDialog } from "@/shared/ui/AppDialog";
import { useStatusLoginStore } from "@/app/statusLoginStore";

/**
 * O diálogo do login de uma conta, aberto pela barra de status. Não fica dentro da barra: é renderizado por
 * `StatusBarRegion`, em fronteira própria, para sobreviver a uma queda da barra.
 */
export function StatusBarLoginDialog() {
  const { t } = useTranslation();
  const loginFor = useStatusLoginStore((s) => s.account);
  if (!loginFor) return null;
  const closeLogin = () => useStatusLoginStore.getState().close();
  return (
    <AppDialog
      title={t("settings.accounts.login.title", { name: loginFor.label ?? loginFor.name })}
      onClose={closeLogin}
      size="lg"
      footer={<Button variant="primary" onClick={closeLogin}>{t("settings.accounts.login.done")}</Button>}
    >
      <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
        {t("settings.accounts.login.helper", { command: accountLoginCommand(loginFor) })}
      </p>
      <LoginTerminal key={loginFor.id} account={loginFor} />
    </AppDialog>
  );
}
