# Paridade do navegador T3 → ADE

Inventário da base `8641ce10`, comparando `PreviewChromeRow`, `PreviewView`, `PreviewEmptyState`, `PreviewMoreMenu`, `BrowserSettingsPanel` e os guias T3 em `docs/user/` com `BrowserTab` e `src-tauri/src/preview/`.

| T3 Code | ADE na base | Cobertura nesta branch |
|---|---|---|
| Barra compacta, navegação, busca por URL ou termo | Barra maior; buscador configurável já existia | Barra enxuta com voltar/avançar/recarregar e placeholder “Search or enter URL”; mantém o buscador configurado. |
| Seletor, câmera, float e menu `⋮` | Seletor/anotação e captura existiam; float no chat era manual | Ações compactas, captura rápida, gravação no menu, mais opções e alternância da prévia flutuante no chat. |
| Estado vazio e servidores locais | Servidores locais e páginas recentes existiam | “No preview yet” traduzido e descoberta local mantida no estado vazio. |
| Perfis e anônimo | WebView2 separava perfis; proxy usava um jar por origem | Perfis nomeados e de agente usam jars próprios cifrados pela chave existente no keyring; anônimo só vive em memória e não guarda histórico. |
| Open links in e buscador | Preferências já existiam; Cmd/Ctrl+clique não invertia destino | Mantidas as opções ADE/sistema e o buscador; Cmd/Ctrl+clique inverte a preferência. |
| Auto-show, gravação, FPS e Advanced | Preferências ausentes | Auto-show ao agente navegar ou mudar para um viewport de aparelho; gravação com máximo de 30/60 fps e seção Browser nas configurações. O auto-show do painel de simulador/dispositivo é integração da superfície de dispositivos, mantida pelo outro agente. |
| Viewports xs–xl, Toque e 1920×1080 | Já existiam em uma faixa visual pesada | Mantidos e descritos em Advanced; barra agora tem altura compacta. |
| Importação de sessões | ADE já importava Firefox | Importação de Chrome, Edge, Brave, Arc, Vivaldi, Opera, Helium, Safari, Firefox e Zen, na seção Browser: lista de navegadores e perfis detectados, perfil de origem, perfil de destino da ADE, revisão por domínio, cópia única cifrada e avisos de permissão (Keychain, Acesso Total ao Disco, navegador aberto). Detalhes e limites em [NAVEGADOR_IMPORTACAO_PLANO.md](./NAVEGADOR_IMPORTACAO_PLANO.md#10-importação-de-todos-os-navegadores-entregue). Nenhum perfil real foi lido no desenvolvimento. |
| Páginas HTML, dispositivos e SnapShots | Preview de viewport/canvas e captura local | Páginas HTML publicadas e SnapShots globais são superfícies separadas. O painel de simuladores/dispositivos fica com o outro agente. |

O perfil padrão preserva a identidade do jar cifrado existente, sem migração. Os arquivos dos demais perfis também usam a chave do keyring; o modo anônimo não cria arquivo persistente. A preferência de auto-show é local e compartilhável com a superfície de dispositivos; este navegador a aplica à navegação e à emulação de aparelho.

Importação de sessões (Chromium, Safari e Zen): só roda por clique, a chave do Chromium só é lida ao confirmar a gravação e nada é gravado em claro. No Windows, Chrome, Edge, Brave, Vivaldi e Opera usam criptografia amarrada ao app e aparecem como não importáveis, como no T3 (só Helium, Firefox e Zen importam). No Linux, todos os Chromium do T3 (Chrome, Edge, Brave, Vivaldi, Opera, Helium) importam: `v10` pela senha padrão `peanuts`, `v11` pela senha do Secret Service (libsecret), com a senha vazia como segunda tentativa; Firefox e Zen também olham snap, Flatpak e `~/.zen`. Arc e Safari só existem no macOS. O destino é o perfil da ADE escolhido; como o estado cifrado hoje vive no proxy de preview, os cookies importados alcançam o preview e ainda não os perfis do WebView2.
