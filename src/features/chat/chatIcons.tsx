/**
 * Os ícones do modo chat: traço de 1,75 como os do T3 Code, cor do texto (`currentColor`). O app
 * não usa uma biblioteca de ícones; os de uso geral ficam em `@/app/icons`.
 */
type IconProps = { className?: string };

function Svg({ className = "w-4 h-4", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const NewChatIcon = (p: IconProps) => <Svg {...p}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></Svg>;
export const SidebarIcon = (p: IconProps) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></Svg>;
export const PaperclipIcon = (p: IconProps) => <Svg {...p}><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10.2 17a1.7 1.7 0 0 1-2.4-2.4L15.5 7" /></Svg>;
export const ArrowUpIcon = (p: IconProps) => <Svg {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Svg>;
export const FolderIcon = (p: IconProps) => <Svg {...p}><path d="M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" /></Svg>;
export const BranchIcon = (p: IconProps) => <Svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-10 6" /></Svg>;
export const ShieldIcon = (p: IconProps) => <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></Svg>;
export const LockIcon = (p: IconProps) => <Svg {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>;
export const ChevronDownIcon = (p: IconProps) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const SettingsIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>;
export const ChatBubbleIcon = (p: IconProps) => <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></Svg>;
export const EyeIcon = (p: IconProps) => <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const PenIcon = (p: IconProps) => <Svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>;
export const FilePlusIcon = (p: IconProps) => <Svg {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M12 12v6M9 15h6" /></Svg>;
export const TerminalIcon = (p: IconProps) => <Svg {...p}><path d="m4 17 6-6-6-6M12 19h8" /></Svg>;
export const GlobeIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Svg>;
export const BotIcon = (p: IconProps) => <Svg {...p}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M9 13v2M15 13v2" /></Svg>;
export const ListIcon = (p: IconProps) => <Svg {...p}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></Svg>;
export const WrenchIcon = (p: IconProps) => <Svg {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z" /></Svg>;
export const QuestionIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" /></Svg>;
export const PanelBottomIcon = (p: IconProps) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 15h18" /></Svg>;
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const FilterIcon = (p: IconProps) => <Svg {...p}><path d="M3 6h18M7 12h10M10 18h4" /></Svg>;
export const FolderPlusIcon = (p: IconProps) => <Svg {...p}><path d="M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" /><path d="M12 10v6M9 13h6" /></Svg>;
export const PullRequestIcon = (p: IconProps) => <Svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4" /><path d="m13 3-2.5 3L13 9" /></Svg>;
export const UsageIcon = (p: IconProps) => <Svg {...p}><path d="M6 20v-6M12 20V4M18 20v-9" /></Svg>;
export const DetailsIcon = (p: IconProps) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 8h10M7 12h10M7 16h6" /></Svg>;
export const PanelRightIcon = (p: IconProps) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></Svg>;
export const MaximizeIcon = (p: IconProps) => <Svg {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></Svg>;
export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const ShieldOffIcon = (p: IconProps) => <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m3 3 18 18" /></Svg>;
export const ZapIcon = (p: IconProps) => <Svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></Svg>;
export function StarIcon({ className = "w-4 h-4", filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9Z" />
    </svg>
  );
}
export function StopIcon({ className = "w-2.5 h-2.5" }: IconProps) {
  return <svg viewBox="0 0 10 10" className={className} aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>;
}
export const ClockIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const FolderGitIcon = (p: IconProps) => <Svg {...p}><path d="M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" /><circle cx="12" cy="13" r="2" /><path d="M14 13h4M6 13h4" /></Svg>;
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
export const PhoneIcon = (p: IconProps) => <Svg {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></Svg>;
export const XIcon = (p: IconProps) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;

// Os controles dos aparelhos do painel (pranchetas 9 e 10).
export const HomeIcon = (p: IconProps) => <Svg {...p}><path d="M3 11 12 4l9 7v9H5v-9" /></Svg>;
export const RotateIcon = (p: IconProps) => <Svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></Svg>;
export const CameraIcon = (p: IconProps) => <Svg {...p}><path d="M4 8h3l2-3h6l2 3h3v11H4Z" /><circle cx="12" cy="13" r="3.5" /></Svg>;
export const ContrastIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></Svg>;
export const PinIcon = (p: IconProps) => <Svg {...p}><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12Z" /><circle cx="12" cy="10" r="2.5" /></Svg>;
export const FaceIdIcon = (p: IconProps) => <Svg {...p}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 9v1M15 9v1M12 9v4h-1M9 16c1.5 1 4.5 1 6 0" /></Svg>;
export const KeyboardIcon = (p: IconProps) => <Svg {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Svg>;
export const BackTriangleIcon = (p: IconProps) => <Svg {...p}><path d="M17 5v14L6 12Z" /></Svg>;
export const CircleIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="7" /></Svg>;
export const SquareIcon = (p: IconProps) => <Svg {...p}><rect x="5" y="5" width="14" height="14" rx="2" /></Svg>;
export const VolumeIcon = (p: IconProps) => <Svg {...p}><path d="M4 9h4l5-4v14l-5-4H4Z" /><path d="M17 9a4 4 0 0 1 0 6" /></Svg>;
export const LogIcon = (p: IconProps) => <Svg {...p}><path d="M4 6h16M4 10h10M4 14h16M4 18h8" /></Svg>;
export function MoreVerticalIcon({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
/** O cadeado do cartão de permissão (prancheta 14). */
export const PadlockIcon = (p: IconProps) => <Svg {...p}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>;
/** O triângulo de aviso do "N agentes esperando você". */
export const WarnIcon = (p: IconProps) => <Svg {...p}><path d="M12 3 2 21h20Z" /><path d="M12 10v4M12 17h.01" /></Svg>;

export const UsersIcon = (p: IconProps) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.6-3.3 3-5 6-5s5.4 1.7 6 5" /><path d="M16 4.6a3.2 3.2 0 0 1 0 6.3M18 15.4c1.6.6 2.7 2.1 3 4.6" /></Svg>;
export const DiffIcon = (p: IconProps) => <Svg {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M9 13h6M9 17h6M12 10v0" /></Svg>;
export const FilesIcon = (p: IconProps) => <Svg {...p}><path d="M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6Z" /><path d="M15 2v4h4M4 7v13a2 2 0 0 0 2 2h9" /></Svg>;
export const DesignIcon = (p: IconProps) => <Svg {...p}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.5-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5-4-10-9-10Z" /><path d="M7.5 11h.01M11 7.5h.01M15.5 9h.01" /></Svg>;
