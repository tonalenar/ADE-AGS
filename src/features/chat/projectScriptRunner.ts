import i18n from "@/i18n";
import { showBotToast } from "@/shared/brand/botToastStore";

import { projectScriptCommandGet } from "./projectScriptsIpc";
import { projectScriptCommandContainsSecret, validProjectScriptCommand } from "./projectScripts";
import { runProjectScript } from "./shellTerminal";

/** Revalida a ação guardada e abre somente um PTY dedicado ao comando escolhido. */
export function runStoredProjectScript(cwd: string, id: string, name: string): void {
  const fail = (key: string, tone: "warning" | "error" = "warning", values?: Record<string, string>) => {
    showBotToast({ title: name, text: i18n.t(key, values), tone });
  };

  void projectScriptCommandGet(cwd, id).then((command) => {
    if (command === null) {
      fail("chat.projectScripts.commandMissing");
      return;
    }
    if (projectScriptCommandContainsSecret(command)) {
      fail("chat.projectScripts.secretInline");
      return;
    }
    if (!validProjectScriptCommand(command)) {
      fail("chat.projectScripts.invalid");
      return;
    }
    return runProjectScript(cwd, name, command).catch((error: unknown) => {
      fail("chat.projectScripts.runError", "error", { error: String(error) });
    });
  }).catch((error: unknown) => {
    fail("chat.projectScripts.runError", "error", { error: String(error) });
  });
}
