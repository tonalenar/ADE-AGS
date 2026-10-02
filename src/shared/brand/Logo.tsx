import { MascotMark } from "./Mascot";

/** O nome do produto. Fica fora do i18n de propósito: marca não se traduz. */
export const PRODUCT_NAME = "ADE AGS";

/**
 * A marca completa: a cabeça do mascote e o nome. "ADE" no tom do texto, "AGS" atenuado —
 * a hierarquia vem do peso e do tom, não de cor, para a marca ficar neutra.
 */
export function Logo({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 select-none ${className}`}>
      <MascotMark size={size} />
      <span className="font-semibold tracking-tight leading-none" style={{ fontSize: size * 0.93 }}>
        <span className="text-gray-900 dark:text-gray-50">ADE</span>{" "}
        <span className="text-gray-500 dark:text-gray-400">AGS</span>
      </span>
    </span>
  );
}
