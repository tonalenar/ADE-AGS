import { useTranslation } from "react-i18next";
import { Button, CloseIcon, Modal } from "neogestify-ui-components";

type DialogSize = "sm" | "md" | "lg" | "xl";

/**
 * El panel. Radio de sheet de macOS y la sombra de `--shadow-pop` (el anillo de 0.5px es
 * el borde que se ve en Apple; el resto da la elevación). Los colores salen de las
 * variables `--nui-*` de `App.css`.
 */
export const DIALOG_PANEL_CLASS =
  "rounded-[14px] shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]";

/** El cuerpo, con el respiro de esta UI en vez del `p-6` de la librería. */
export const DIALOG_BODY_CLASS = "px-5 py-5 cc-scroll";

/**
 * La cabecera de un diálogo: título centrado, como en los sheets de macOS, con la X
 * flotando a la derecha. El `px-10` reserva el hueco de la X de los dos lados para que el
 * título quede centrado de verdad y no corrido.
 *
 * Se exporta suelta para que la use también `ViewModal`, que monta el `Modal` de la
 * librería por su cuenta para poder portalearlo dentro de la vista.
 */
export function DialogHeader({ title, icon, onClose }: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative flex items-center justify-center gap-2 h-[52px] shrink-0 px-12
      border-b border-gray-200 dark:border-[rgba(84,84,88,0.55)]">
      {icon}
      <h2 className="flex-1 min-w-0 truncate text-center text-[15px] leading-5 font-semibold tracking-[-0.2px]
        text-gray-900 dark:text-[#f5f5f7]">
        {title}
      </h2>
      {/* Cerrar está siempre, incluso cuando el diálogo no se cierra con Escape ni
          clickeando afuera: sin salida visible, un login a medias parece un cuelgue. */}
      <Button variant="icon"
        onClick={onClose}
        title={t("btn.close")}
        aria-label={t("btn.close")}
        className="cc-t absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-md shrink-0
          text-gray-400 dark:text-white/35
          hover:text-gray-700 dark:hover:text-white
          hover:bg-gray-200 dark:hover:bg-white/10 p-0"
      >
        <CloseIcon className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

/**
 * Un diálogo de la app.
 *
 * Monta sobre el `Modal` de la librería en vez de reimplementarlo: de ahí salen el portal,
 * la capa, el velo, el bloqueo del scroll, la trampa de foco y el Escape. Lo que cambia es
 * la piel.
 *
 * Los COLORES no se tocan acá. Salen de las variables `--nui-*` que declara `App.css`, que
 * es lo que hace que el resto de los componentes de la librería (botones, inputs, badges)
 * combinen sin que cada diálogo tenga que pisar clases.
 *
 * `closeOnBackdrop` y `closeOnEsc` arrancan apagados, igual que en la librería: hay
 * diálogos —un login a medias, una instalación en curso— en los que cerrar sin querer deja
 * las cosas por la mitad, así que cada uno lo pide explícitamente.
 */
export function AppDialog({
  title,
  icon,
  size = "md",
  footer,
  onClose,
  closeOnBackdrop = false,
  closeOnEsc = false,
  variant,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  size?: DialogSize;
  footer?: React.ReactNode;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  variant?: "default" | "danger" | "success" | "warning";
  children: React.ReactNode;
}) {
  return (
    <Modal
      onClose={onClose}
      size={size}
      variant={variant}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEsc={closeOnEsc}
      // La cabecera se sustituye entera, así que hace falta `aria-label`: ya no hay un
      // título de la librería al que apuntar.
      aria-label={title}
      className={DIALOG_PANEL_CLASS}
      bodyClassName={DIALOG_BODY_CLASS}
      header={<DialogHeader title={title} icon={icon} onClose={onClose} />}
      footer={footer}
    >
      {children}
    </Modal>
  );
}
