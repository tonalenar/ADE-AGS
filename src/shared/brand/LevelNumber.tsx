import { useLevelUp } from "./levelUpFx";
import "./pet.css";

/** O número do LV. Ao subir, o antigo sai para cima e o novo entra girando, como num slot
 *  de fliperama (a animação mora em `pet.css`; sem movimento, o número só troca). */
export function LevelNumber({ level }: { level: number }) {
  const lu = useLevelUp(level);
  if (!lu.active) return <span className="ags-lvnum">{level}</span>;
  return (
    <span key={lu.key} className="ags-lvnum ags-lvnum--roll">
      <b className="ags-lvnum__old" aria-hidden>{lu.from}</b>
      <b className="ags-lvnum__new">{level}</b>
    </span>
  );
}

/** Classe que faz a barra de EXP piscar enquanto o nível sobe (a barra "transborda"). */
export function useLevelBarClass(level: number): string {
  return useLevelUp(level).active ? "ags-lvbar--flash" : "";
}
