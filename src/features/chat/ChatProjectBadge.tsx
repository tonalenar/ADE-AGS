import { projectTone } from "./chatModel";
import { useChatProjectIdentity } from "./chatProjectIdentity";

/** Ícone local do projeto, compartilhado entre seletor, sidebar e breadcrumb. */
export function ProjectBadge({ name, cwd, size = "md", muted = false }: { name: string; cwd?: string | null; size?: "sm" | "md"; muted?: boolean }) {
  const identity = useChatProjectIdentity(cwd);
  const box = size === "sm" ? "w-3.5 h-3.5 text-[8px] rounded" : "w-4 h-4 text-[9px] rounded";
  return (
    <span aria-hidden="true"
      className={`${box} shrink-0 inline-flex items-center justify-center font-bold text-white ${projectTone(name)} ${muted ? "opacity-50 grayscale" : ""}`}>
      {identity.icon?.kind === "image" ? <img src={identity.icon.value} alt="" className="h-full w-full rounded object-cover" />
        : identity.icon?.value ?? name.charAt(0).toUpperCase()}
    </span>
  );
}
