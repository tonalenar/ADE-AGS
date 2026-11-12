# Navegador da ADE: Chromium nativo no Tauri 2

O navegador da ADE segue o do T3 Code: o mesmo motor (Chromium), a mesma barra e a mesma miniatura. A escolha do motor e a causa da queda que travou a primeira tentativa estão em [NAVEGADOR_CEF_TAURI2.md](../decisoes/NAVEGADOR_CEF_TAURI2.md).

## Motor por plataforma

| Plataforma | Motor | Onde |
|---|---|---|
| macOS | Chromium via CEF (`cef-rs` 156), no mesmo processo do Tauri 2, como `NSView` filha da janela | `src-tauri/src/real_browser/cef_native.rs` |
| Windows | WebView2, que já é Chromium | `src-tauri/src/real_browser/native.rs` |
| Linux | o preview por proxy de antes, como fallback | `src-tauri/src/preview/` |

O motivo da troca: o WKWebView com proxy fazia o Google responder com `/sorry` e barrava login e sites externos. No Chromium embutido, `https://www.google.com/search?q=…` abre a página de resultados, `https://github.com/login` abre o formulário, o User-Agent é o padrão do Chrome (`Chrome/156.0.0.0`) e `navigator.webdriver` é `false`.

## Vista, buracos e miniatura

- A interface manda `real_browser_place` a cada quadro: o retângulo, as partes à vista e os buracos (menus, diálogos e popovers da ADE por cima). O motor move e redimensiona a **mesma** vista, sem recriar a página.
- No macOS, a vista hospedeira é a classe `ADEPortalHost`. A máscara recorta o desenho e o `hitTest:` devolve o clique de um buraco à interface. Só a máscara deixava a página por cima do menu.
- Ao recolher o painel, a mesma vista vira a miniatura: cartão no canto inferior direito, cantos de 16 px, borda e sombra, página ao vivo com zoom proporcional.
  - O host nativo avisa entrada e saída do mouse (`real-browser-mini-hover`) e só então a pílula aparece. Ela tem três botões: painel lateral, painel expandido/janela e fechar.
  - O buraco da pílula só existe enquanto ela aparece.
  - Clicar na página reabre o painel (`real-browser-mini-click`). Fechar a miniatura não encerra a sessão.

## Sessão e perfis

- Cada perfil da ADE em cada projeto tem uma partição persistente em `<dados da ADE>/app-data/portal-chromium/<perfil>-<hash do projeto>`.
  - O caminho do projeto não vai para o disco: só um hash de 128 bits.
  - O runtime Chrome do CEF só cria perfis filhos diretos do `root_cache_path`; um caminho aninhado caía num perfil anônimo, sem persistência.
- Nenhum perfil real de navegador do usuário é lido nem usado. O modo anônimo usa um contexto em memória.
- Excluir um perfil gerenciado apaga as partições dele, e só as dele: `work` não leva `work-2`.
- A chave de cifra dos cookies fica no Keychain do sistema, como no Chrome. No build de debug, que muda de assinatura a cada compilação, o Chromium usa um Keychain simulado (`--use-mock-keychain`) para não pedir acesso a cada execução.
- Os dados do WKWebView antigo (`portal-webview`) ficam intactos. No macOS não há cópia para o Chromium, porque os formatos são diferentes. Cookies importados em Configurações continuam aplicados por CDP, por origem.

## Pop-ups e OAuth

- `window.open`, `target=_blank` e pop-ups de OAuth abrem numa **aba nova** da ADE, com o `opener` vivo.
  - O CEF cria o pop-up como vista filha de um host oculto, na partição do opener.
  - A interface recebe `real-browser-popup` e abre a aba com o mesmo id. A aba adota o pop-up já criado, sem recarregar.
- Quando a página se fecha (`window.close()` no fim do OAuth), a aba fecha junto (`real-browser-closed`).
- O `DoClose` do CEF sempre devolve `true`: o padrão mandaria `performClose:` à janela de topo, que é a janela da ADE.
- Só `http`, `https` e `about:blank` abrem; `file:`, `javascript:` e esquemas de app são recusados.

## Agentes e CDP

- `ags portal …`, `ags browser run` e as tools MCP `browser_*` chegam pelo IPC local do app (socket Unix com PID e token) e viram CDP pelo objeto do motor (`execute_dev_tools_method`).
- Não há `remote_debugging_port` nem listener TCP. Nada escuta em rede, nem em 127.0.0.1.

## Interface

- A barra segue a do T3:
  - abas de navegador com `+`;
  - voltar, avançar e recarregar;
  - "Pesquisar ou digitar URL";
  - selecionar e anotar elemento;
  - captura;
  - abrir em painel ou janela;
  - menu `⋮`.
- O estado vazio mostra "Nenhuma prévia ainda" e os servidores locais detectados da conversa.
- Strings nos três catálogos, ícones de `chatIcons.tsx`, cores por token.

## Diagnóstico (só debug)

- `ADE_CEF_TRACE=1`: rastro da bomba de mensagens, da criação e do fechamento no stderr.
- `ADE_CEF_LOG_FILE=<arquivo>`: log verboso do Chromium.
- `ade-ags --cef-probe`: sobe e derruba o CEF sem janela.
- `ADE_CEF_SELFTEST=<url>[,<url>…]` com `ADE_CEF_SELFTEST_OUT=<pasta>`: cria o navegador na janela sem passar pela interface. Para cada URL, grava título, UA e `webdriver`, e uma captura PNG por CDP. Depois abre um pop-up por clique simulado, confere o `opener` e o fechamento pela página. Funciona com a tela bloqueada.

## Limites conhecidos

- Passkeys com Touch ID: o Chromium pede o entitlement `keychain-access-group`, que o build local não tem.
- Câmera, microfone e localização perguntam por um diálogo nativo da ADE; não foram exercitados com site real.
- O pacote fica bem maior: o framework do Chromium e cinco helpers entram em `Contents/Frameworks` (números na decisão).
