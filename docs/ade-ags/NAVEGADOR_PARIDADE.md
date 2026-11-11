# Paridade do navegador T3 → ADE

Inventário da base `8641ce10`, comparando `PreviewChromeRow`, `PreviewView`, `PreviewEmptyState`, `PreviewMoreMenu`, `BrowserSettingsPanel` e os guias T3 em `docs/user/` com `BrowserTab` e `src-tauri/src/preview/`.

| T3 Code | ADE na base | Cobertura nesta branch |
|---|---|---|
| Barra compacta, navegação, busca por URL ou termo | Barra maior; buscador configurável já existia | Barra enxuta com voltar/avançar/recarregar e placeholder “Search or enter URL”; mantém o buscador configurado. |
| Seletor, câmera, float e menu `⋮` | Seletor/anotação e captura existiam; float no chat era manual | Ações compactas, captura rápida, gravação no menu, mais opções e alternância da prévia flutuante no chat. |
| Estado vazio e servidores locais | Servidores locais e páginas recentes existiam | “No preview yet” traduzido e descoberta local mantida no estado vazio. |
| Perfis e anônimo | WebView2 separava perfis; proxy usava um jar por origem | Perfis nomeados e de agente usam jars próprios cifrados pela chave existente no keyring; anônimo só vive em memória e não guarda histórico. |
| Open links in e buscador | Preferências já existiam; Cmd/Ctrl+clique não invertia destino | Mantidas as opções ADE/sistema e o buscador; Cmd/Ctrl+clique inverte a preferência. |
| Auto-show, gravação, FPS e Advanced | Preferências ausentes | Auto-show ao agente navegar ou mudar para um viewport de aparelho; gravação com máximo de 30/60 fps e seção Browser nas configurações. O auto-show do aparelho que o agente cria é desta fatia: ver [PAGINAS_HTML_E_SNAPSHOTS.md](./PAGINAS_HTML_E_SNAPSHOTS.md#1-aparelho-flutuante-auto-show). |
| Viewports xs–xl, Toque e 1920×1080 | Já existiam em uma faixa visual pesada | Mantidos e descritos em Advanced; barra agora tem altura compacta. |
| Importação de sessões | ADE já importava Firefox | Importação atual preservada na seção Browser. Não ampliei as fontes para Safari/Zen/Helium do T3; esta branch não lê perfis reais de navegadores. |
| Páginas HTML, dispositivos e SnapShots | Preview de viewport/canvas e captura local | Páginas HTML e a galeria de SnapShots são superfícies próprias ([PAGINAS_HTML_E_SNAPSHOTS.md](./PAGINAS_HTML_E_SNAPSHOTS.md)). O painel de aparelhos segue com o outro agente. |

O perfil padrão preserva a identidade do jar cifrado existente, sem migração. Os arquivos dos demais perfis também usam a chave do keyring; o modo anônimo não cria arquivo persistente. A preferência de auto-show é local e compartilhável com a superfície de dispositivos; este navegador a aplica à navegação e à emulação de aparelho.
