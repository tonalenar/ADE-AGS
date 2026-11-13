# Decisão: Chromium (CEF) dentro do processo do Tauri 2 no macOS

**Data:** 12 de novembro de 2026
**Estado:** adotada

## Contexto

O navegador da ADE no macOS era um WKWebView com proxy local. Com ele, o Google mostrava `/sorry`, o login era barrado e vários sites externos falhavam. O usuário decidiu trocar pelo mesmo motor do T3 Code (Chromium) e manter o mesmo desenho.

A integração CEF mantida para Tauri usa Tauri 3 alpha, mas o resto da ADE depende do Tauri 2 estável: janelas, PTYs, plugins, updater e IPC.

## Decisão

- Manter o Tauri 2. No macOS, integrar `cef-rs` (CEF 156) **diretamente, no mesmo processo**, como `NSView` filha da janela.
- A vista é posicionada pelo mecanismo de retângulo, visibilidade e buracos de `real_browser` (`Place`).
- No Windows, segue o WebView2, que já é Chromium. O Linux mantém o preview por proxy como fallback.

A alternativa era rodar o CEF num processo próprio ("ADE AGS Browser"), numa janela filha sem borda que acompanha o `Place`. Ela ficou descartada porque o caminho no mesmo processo funcionou, e a janela filha traria três custos:

- tiraria o foco de teclado da janela da ADE (a barra de título apagaria ao digitar na página);
- exigiria sincronizar posição, Spaces e tela cheia entre janelas;
- duplicaria o canal CDP entre processos.

## A queda da primeira tentativa

A instância de debug abria só a barra de menus e caía em cerca de 40 s com `EXC_BREAKPOINT` (um `CHECK` do Chromium) dentro de `cef_initialize`. A chamada vinha de `real_browser::native::create_on_main`, no primeiro `real_browser_open`. Os relatórios não trazem a mensagem do `CHECK`.

Investigação, sem janela e sob `lldb` para não gerar o aviso de queda:

- `ade-ags --cef-probe` (CEF antes do `NSApplication` rodar) e uma sonda com o `CefInitialize` chamado de dentro do run loop do AppKit **sobem sem erro** com o código atual.
- No app real, um autoteste (`ADE_CEF_SELFTEST`) inicializa o CEF tarde, dentro do loop do tao, e não cai. Inicializar fora da thread principal ou depois do `NSApplication` não era a causa: `CefInitialize` roda na thread principal e funciona tarde.
- Causa provável: a versão que caía (commit `09ae472f`) chamava o CEF com um executável de debug fora de qualquer `.app`. Também não passava `main_bundle_path`, `framework_dir_path`, `resources_dir_path` nem `root_cache_path`. Sem bundle, o Chromium não acha o framework nem os recursos (`icudtl.dat`, `.pak`, `locales`) e para num `CHECK`. Com o bundle de debug preparado (`scripts/stage-cef-dev.mjs`) e esses caminhos, a queda não voltou. A versão antiga não foi recompilada para confirmar a mensagem exata do `CHECK`.

Os defeitos que vieram depois não derrubavam o app, mas impediam o navegador de funcionar. Cada um foi achado no log do CEF ou no rastro `ADE_CEF_TRACE`:

| Sintoma | Causa | Correção |
|---|---|---|
| `Sandbox setup failed`, GPU e rede não sobem | Com `browser_subprocess_path` vazio, o CEF deduz `ade-ags Helper (GPU).app` pelo nome do executável; os helpers se chamam `ADE AGS Helper…`. O `NSBundle` do helper sai nil | O caminho do helper base é passado explicitamente. Com ele, o CEF roda **todos** os subprocessos (GPU, Renderer, rede) no helper base: as variantes com sufixo ficam no bundle, mas não foram vistas em uso |
| `Cannot create profile at path …/profiles/x/projects/y` | O runtime Chrome só cria perfis filhos diretos do `root_cache_path`; caía num perfil anônimo, sem persistência | Raiz `app-data/portal-chromium`, partição `<perfil>-<hash>` |
| `create_browser_sync` devolve nulo | O perfil persistente inicializa de forma assíncrona | `create_browser` assíncrono; `create` espera o `on_after_created` |
| A página não carrega, o CDP não responde | Com bomba externa, o CEF pediu trabalho uma vez e parou de pedir. O `run_on_main_thread` do tao também não roda em menus e janelas modais | Bomba na fila principal do GCD (*common modes*) com teto de 33 ms entre chamadas, como o `cefclient` |
| `Keychain lookup failed (userCanceledErr)` e espera longa | O Chromium guarda a chave dos cookies no Keychain. A assinatura ad-hoc do debug muda a cada build e o macOS pede permissão a cada execução | `--use-mock-keychain` só em debug; o build assinado usa o Keychain do sistema |
| Fechar uma aba mandaria fechar a janela da ADE | `DoClose` no padrão (`false`) faz o CEF enviar `performClose:` à janela de topo | `DoClose` devolve `true` e desmonta a vista; o browser é destruído no `dealloc` |
| O browser não fecha ao sair do app | Autoreleases do fechamento seguravam a vista dentro de um único callback | Pool de autorelease próprio no fechamento; `CefShutdown` só depois do `on_before_close` |
| Release assinado: `V8 process OOM (Failed to reserve virtual memory for CodeRange)` no log, o CDP não responde ("O CEF não respondeu ao comando CDP a tempo") | O renderer roda no helper base, que estava sem `allow-jit`. Com hardened runtime o V8 não reserva a memória de JIT. O debug não tem hardened runtime e não mostrava isso | O helper base também é assinado com `CefHelperJitEntitlements.plist` |
| O piloto da página nunca conecta (os agentes ouvem "no page loaded") | Sem `Page.enable`, o Chromium aceita o `Page.addScriptToEvaluateOnNewDocument` e não roda o script | `add_script` liga o domínio Page antes de registrar o piloto |
| Cmd+tecla sem `keyUp` | A classe de `NSApplication` do CEF substitui a `TaoApp` | O `sendEvent:` repete o ajuste do tao |

## Consequências

- O framework CEF e cinco helpers (`ADE AGS Helper`, `(GPU)`, `(Renderer)`, `(Plugin)`, `(Alerts)`) entram em `Contents/Frameworks`.
  - Cada helper tem um identificador próprio (`com.luis.controlcode.helper[.gpu|.renderer|…]`).
  - O helper base, o GPU e o Renderer levam o entitlement de JIT; Plugin e Alerts só o de validação de biblioteca.
  - O staging (`scripts/stage-cef-macos.mjs`) respeita `CC_CLI_TARGET` para o build cruzado do release.
- O processo principal carrega o framework na partida para registrar a classe de `NSApplication` exigida pelo CEF (`CrAppControlProtocol`). O `CefInitialize` só roda quando o primeiro navegador abre. O custo na partida não foi medido.
- CDP só pelo objeto do motor: `remote_debugging_port = 0`, sem listener. Os agentes chegam pelo IPC local (socket com PID e token).
- Pop-ups viram abas novas com `opener`; a página que se fecha fecha a aba.
- O proxy segue no fallback Linux e para os cookies importados; o WKWebView deixou de ser o navegador do macOS.

## Tamanho do app

| Medição | Tamanho |
|---|---:|
| Antes (app instalado de referência, sem CEF) | 59,3 MiB (60.764 KiB) |
| Depois (build assinado com CEF, `bun run tauri build --bundles app`) | 387,7 MiB (397.020 KiB) |
| Diferença | +328,4 MiB |

Medido com `du -sk` na pasta `.app`; o build assinado foi conferido com `codesign --verify --deep --strict`.
