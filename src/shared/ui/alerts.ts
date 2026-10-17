import { activeScheme, resolveColor } from "neogestify-ui-components";
import type { SweetAlertIcon, SweetAlertPosition, SweetAlertResult } from "sweetalert2";

/**
 * Os alertas do neogestify (`AlertaToast`, `AlertaConfirmacion`) com o sweetalert2 (~79 KB) sob
 * demanda: importados do pacote, eles levavam o sweetalert2 para o entry, mesmo sem nenhum alerta
 * aberto. Mesmas cores e mesmo comportamento da biblioteca (`dist/chunk-*.mjs`, `Alerta`).
 */
const swal = () => import("sweetalert2").then((m) => m.default);

function colors() {
  const scheme = activeScheme();
  const color = (token: Parameters<typeof resolveColor>[0]) => resolveColor(token, scheme);
  return {
    background: color("surface-muted"),
    color: color("text"),
    confirmButtonColor: color("accent"),
    cancelButtonColor: color("text-subtle"),
    denyButtonColor: color("danger"),
  };
}

/** Um aviso curto no canto, que some sozinho. */
export function AlertaToast(
  title: string,
  text: string,
  icon: SweetAlertIcon = "info",
  timer = 3000,
  position: SweetAlertPosition = "top-end",
): Promise<SweetAlertResult> {
  return swal().then((Swal) =>
    Swal.fire({ ...colors(), title, text, icon, toast: true, timer, position, showConfirmButton: false, timerProgressBar: true }),
  );
}

/** Pergunta de sim/não. `isConfirmed` no resultado. */
export function AlertaConfirmacion(title: string, text: string): Promise<SweetAlertResult> {
  return swal().then((Swal) =>
    Swal.fire({
      ...colors(),
      title,
      text,
      icon: "question",
      showCancelButton: true,
      confirmButtonText: "Sí",
      cancelButtonText: "No",
      position: "center",
      showConfirmButton: true,
    }),
  );
}
