# Parecer: extensões oficiais de VS Code no canvas do ADE AGS

Data da leitura: 4 de outubro de 2026. Este texto não muda o produto. Não instala, não descompila e não redistribui nenhum VSIX.

## Resposta curta

Não dá para colocar as extensões oficiais do Claude Code, do Codex e do Antigravity dentro de um nó do canvas. As três são extensões de desktop do VS Code: um `main` em Node, webviews e a API do editor. O canvas de hoje é um quadro de abas cujo miolo é um PTY (`claude`, `codex`, `agy`) desenhado pelo xterm por cima do nó.

O caminho que cabe no ADE é reimplementar um painel nosso em cima dos protocolos que essas extensões já usam por baixo, e deixar o PTY como está. O primeiro candidato é o `codex app-server`, que o backend já fala para listar modelos e ler cota, e que a OpenAI documenta como a interface para um cliente rico próprio. A extensão em si continua fechada.

Embutir um VS Code (code-server ou OpenVSCode Server) ou escrever um extension host nosso reproduz um IDE inteiro para ganhar uma barra lateral que não é um nó do canvas. O custo, o encaixe com peers/missões e o risco de licença não se pagam.

## O que o canvas é hoje

A app é Tauri 2. O frontend é React. O canvas (`src/features/canvas/CanvasView.tsx`) é um React Flow. Cada agente visível é uma aba (`Tab`). A conexão entre nós é permissão: o backend guarda o quadro em `~/.ags/canvas.json` e `canvas::peers_of` decide quem pode falar com quem. O processo na aba não pode furar essa regra, porque quem pede é o `ags` dentro do terminal.

O desenho da sessão não mora no nó. `TerminalPanel` fica montado o tempo todo, para não matar o processo, e posiciona cada xterm em cima do retângulo que o canvas publica (`liveRects`). `pty_create` (`terminal/pty_manager.rs`) abre um PTY com `portable-pty`, mede colunas e linhas antes do spawn e emite `pty-data-{id}`. Fechar a aba mata a descendência (no Windows, Job Object).

A terminal só fica viva com o zoom em 100%. Escalar o xterm com CSS quebra célula, clique e seleção (`src/features/canvas/geometry.ts`). Longe disso, o nó mostra uma prévia de texto.

O catálogo de fábrica está em `src-tauri/src/agents/registry.rs`. No canvas, os três agentes desta pesquisa são:

| id | binário | o que a aba interativa faz | o que a frota headless faz |
|---|---|---|---|
| `claude-code` | `claude` | TUI no PTY; MCP da app por flags | `claude -p --output-format stream-json`, com broker de permissão |
| `codex` | `codex` | TUI no PTY; sem MCP da app (`McpStyle::None`) | `codex exec --json` com sandbox `workspace-write` ou `read-only` |
| `antigravity` | `agy` | TUI no PTY; sem MCP da app | `agy --print --output-format stream-json`, perfil temporário, política de deny |

Missão em terminais (`src/features/missions/terminals.ts`) abre essas mesmas abas no canvas da missão, liga o orquestrador aos vizinhos e cola o briefing quando a TUI sobe (`sendWhenReady`). O nível `safe` (`autonomy.ts`, PR #43, já em `master`) acrescenta `--approve-for-me` no Codex, `--mode accept-edits` no Antigravity e `--approval-mode auto_edit` no Gemini. Esse nível não usa `--dangerously-*`.

A frota (`runs/`) não passa pelo PTY. Os adapters leem JSON linha a linha e publicam no bus `ade-event` (`src-tauri/src/bus.rs`): `seq`, tópico, história curta de 2000 eventos. A saída do PTY não entra nesse bus. `ags peer check` lê a tela. `peer ask` / `peer tell` digitam na TUI.

O Codex do canvas ainda precisa de um remendo: o sandbox dele descarta `ADE_TAB_ID`, e sem essa variável o `ags peers` não sabe quem pergunta. `with_codex_tab_id` injeta a variável pela config `shell_environment_policy.set` só quando o programa é `codex`.

Conta, no modelo atual, é diretório mais variável de ambiente por processo (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). A app não lê o segredo. O Antigravity nativo não tem esse isolamento: o login fica no keyring do sistema (`supports_accounts = false`).

## Como as extensões oficiais funcionam

Uma extensão de VS Code não é uma página. O workbench (a UI) e o extension host são processos separados. O host local é Node.js e exige um `main` no `package.json`. O host web é um Web Worker e exige um `browser`. Os dois falam por RPC interno (`extHost.protocol`), que muda com o VS Code e não é uma biblioteca estável para terceiros. Webview da extensão é um iframe controlado por esse RPC: o HTML não chama a API do editor; quem chama é o host Node.

Fonte: [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host), documentação da API do VS Code.

As três extensões, lidas no manifesto publicado no Open VSX em 4 de outubro de 2026, são host local. Nenhuma declara `browser`.

| Extensão | ID | Versão lida | `engines.vscode` | Entrada | UI que declara |
|---|---|---|---|---|---|
| Claude Code | `Anthropic.claude-code` | 2.1.289 (3 out 2026) | `^1.94.0` | `./extension.js` | webview de sidebar e painel `claudeVSCodePanel`; diffs e comentários por hunk; esquema de editor `_claude_vscode_fs_right` |
| Codex | `openai.chatgpt` | 26.5908.31748 (11 set 2026), alias `latest` marcado como pre-release | `^1.96.2` | `./out/extension.js` | webview de sidebar; VSIX por plataforma |
| Antigravity | `Google.google-antigravity` | 1.5.0 (23 set 2026), universal | `^1.80.0` no manifesto | `./extension.js` | webview `antigravity.panel`; custom editor `antigravity.artifactEditor`; comandos de inline diff |

Ativam em `onStartupFinished`. Ou seja, sobem com a janela do editor, não quando um nó do canvas pede.

O que cada uma faz por baixo, em fonte do fabricante:

- **Claude Code.** A extensão exige VS Code 1.94 ou maior e uma conta Anthropic (Pro, Max, Team, Enterprise ou Console). A UI gráfica é o padrão; `claudeCode.useTerminal` volta para a TUI. Com a extensão ativa, um servidor MCP local escuta em `127.0.0.1` numa porta aleatória, transporte `ws://` sem TLS, token em `~/.claude/ide/.lock` (ou `$CLAUDE_CONFIG_DIR/ide/` se a variável existir). Esse canal é o que abre diff nativo, lê a seleção e executa célula de notebook. A maior parte das tools desse servidor é RPC interno, filtrada antes de chegar ao modelo. Fonte: [Use Claude Code in VS Code](https://code.claude.com/docs/en/vs-code). O Agent SDK, caminho de quem não quer a extensão, também não é uma API HTTP: `query()` sobe um subprocesso `claude` e fala por stdio. Fonte: [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting).
- **Codex.** A extensão é um cliente rico do mesmo harness da CLI. O protocolo é o app-server: processo longo, JSON-RPC em JSONL no stdio. O cliente manda `initialize` com `clientInfo` (a extensão se apresenta como `codex_vscode`), depois `thread/start` e `turn/start`, e recebe notificações de raciocínio, aprovação e diff. A OpenAI diz que o app-server existe para integração funda dentro de outro produto (auth, histórico, aprovações, eventos). A implementação está em `openai/codex`, em `codex-rs/app-server`. Fontes: [Codex App Server](https://developers.openai.com/codex/app-server), [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/). Um engenheiro da OpenAI descreveu a extensão como “UI wrapper” em volta da CLI e afirmou que ela não é open source ([issue 2938](https://github.com/openai/codex/issues/2938), comentário de etraut-openai em 29 out 2025; repetido na [issue 4352](https://github.com/openai/codex/issues/4352)).
- **Antigravity.** A documentação pede VS Code 1.90 ou maior (o manifesto 1.5.0 declara `^1.80.0`; o número da doc é o que a Google publica como pré-requisito). No primeiro arranque a extensão instala o serviço local `agy` e o login é o mesmo das outras superfícies. A UI é sidebar, diff inline e planos em custom editor. Fonte: [Antigravity for Visual Studio Code](https://antigravity.google/docs/ide/extensions/vscode/). O ADE já fala com o CLI, não com essa extensão: `agy --print --output-format stream-json`, documentado em `docs/ade-ags/ANTIGRAVITY_INTEGRATION.md`.

Nenhuma das três é um widget que se solta do workbench. Diff, seleção, worktree, comentário por hunk e custom editor são serviços do VS Code. Um webview do Tauri não os tem.

Há um desencontro de produto, independente de licença. A extensão é uma por janela de editor (a sidebar). O canvas é um processo por nó, com aresta de permissão entre eles. Colocar “a extensão” no quadro ou vira um IDE único para a pasta inteira (some o mapa de agentes) ou vira um IDE por nó (um workbench e um extension host por aba).

## Licença, termos e onde são distribuídas

As três estão no Visual Studio Marketplace e no Open VSX, publicadas pelos fabricantes (namespace verificado no Open VSX). Estar nos dois registros não autoriza o ADE a embuti-las.

| | Marketplace | Open VSX (consulta de 4 out 2026) | Licença do artefato |
|---|---|---|---|
| Claude Code | [`anthropic.claude-code`](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | [`Anthropic/claude-code`](https://open-vsx.org/extension/Anthropic/claude-code), API `2.1.289` | “All rights reserved”, sujeita aos acordos em [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). O `LICENSE.md` do repositório público repete isso e aponta os [Commercial Terms](https://www.anthropic.com/legal/commercial-terms). |
| Codex | [`openai.chatgpt`](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) | [`openai/chatgpt`](https://open-vsx.org/extension/openai/chatgpt), API `26.5908.31748` | `LICENSE.md` do VSIX: “See https://openai.com/policies/row-terms-of-use”. Não é a Apache-2.0 do CLI. |
| Antigravity | [`Google.google-antigravity`](https://marketplace.visualstudio.com/items?itemName=Google.google-antigravity) | [`Google/google-antigravity`](https://open-vsx.org/extension/Google/google-antigravity), API `1.5.0` | O `LICENSE.txt` dentro do VSIX 1.5.0 é o texto MIT genérico com copyright da Microsoft (o aviso que o gerador de extensão do VS Code deixa no projeto). Isso não é, por si, uma licença da Google sobre o produto. O uso do Antigravity segue os termos da conta Google / Gemini Enterprise descritos na doc da extensão. Antes de redistribuir esse arquivo, alguém jurídico precisa confirmar o que vale. Este parecer não trata a extensão como MIT. |

O que cada registro permite:

- **Marketplace (termos de janeiro de 2025).** Ofertas do Marketplace só podem ser instaladas e usadas com produtos no escopo: Visual Studio, Visual Studio Code, GitHub Codespaces, Azure DevOps, Azure DevOps Server e sucessores. O texto proíbe instalar, fazer engenharia reversa, importar ou usar essas ofertas em outros produtos. A licença do editor (Anthropic, OpenAI, Google) é um segundo contrato, e a Microsoft não é parte dele. Fonte: [Microsoft Visual Studio Marketplace Terms of Use](https://cdn.vsassets.io/v/M253_20250303.9/_content/Microsoft-Visual-Studio-Marketplace-Terms-of-Use.pdf), seções 1, 2.b e 3. O ADE, o code-server e o OpenVSCode Server não estão nessa lista. O próprio code-server recusou o Marketplace por causa desses termos ([coder/code-server#990](https://github.com/coder/code-server/issues/990)).
- **Open VSX.** Registro da Eclipse, neutro, para editores compatíveis. Publicar exige o [Open VSX Publisher Agreement](https://www.eclipse.org/legal/documents/eclipse-openvsx-publisher-agreement.pdf). A licença é entre o editor e quem usa. Se o editor não declara licença, o acordo cai em MIT; estes três declararam. Baixar o VSIX do Open VSX não apaga os termos da Anthropic, da OpenAI ou da Google. FAQ: [Open VSX Registry FAQ](https://www.eclipse.org/legal/open-vsx-registry-faq/).

Claude Code tem uma regra própria que importa mesmo sem VSIX. Nos [termos publicados](https://code.claude.com/docs/en/legal-and-compliance), em 4 out 2026:

- Pré-instalar ou rodar Claude Code dentro de produto de terceiro exige os Commercial Terms, o binário sem modificação, e cada usuário autenticando com a própria conta ou a própria chave. O produto não pode pagar, revender nem intermediar o uso.
- Quem constrói produto em cima das capacidades do Claude, inclusive com o Agent SDK, deve usar chave de API (Console ou nuvem suportada). A Anthropic não permite que o terceiro ofereça login do Claude.ai dentro do próprio app, nem que encaminhe pedidos com credencial Free, Pro ou Max em nome do usuário, nem que guarde token de sessão. O login de conta Claude tem de terminar no fluxo da Anthropic.
- Isso não impede a pessoa de entrar, ela mesma, no binário `claude` sem modificação, inclusive quando uma plataforma hospeda esse binário nas condições acima.

O canvas atual está do lado permitido dessa frase: sobe o `claude` que o usuário instalou, e o login acontece no terminal dele. Um painel nosso que passasse a guardar o OAuth, ou um SDK embutido que oferecesse “entrar com Claude” dentro do ADE, sai dessa frase. A extensão oficial, se um dia rodasse num VS Code de verdade, faria o login no fluxo dela. Dentro de um host que não é VS Code, além do problema de Marketplace, o fluxo de login deixa de ser o que a Anthropic descreve.

O CLI e o app-server do Codex estão no repositório `openai/codex` sob Apache-2.0 ([LICENSE](https://github.com/openai/codex/blob/main/LICENSE)). Esse é o pedaço que a OpenAI diz para usar num produto próprio. A extensão gráfica não está nesse repositório.

code-server ([coder/code-server](https://github.com/coder/code-server)) e OpenVSCode Server ([gitpod-io/openvscode-server](https://github.com/gitpod-io/openvscode-server)) são MIT em cima do Code - OSS. A licença MIT cobre o editor, não as extensões proprietárias que se instalam nele, e não abre o Marketplace.

## Três caminhos

### A. Embutir VS Code, code-server ou OpenVSCode Server num webview

Um servidor local sobe o workbench. O nó, ou um painel ao lado, mostra esse workbench num iframe. As extensões instalam por Open VSX (Marketplace fica de fora pelos termos acima) e rodam no extension host Node de verdade.

Esforço. Subsistema novo: ciclo de vida do servidor, porta, atualização do editor, atualização das três extensões, pasta de extensões por usuário, CSP do Tauri (`frame-src` hoje é localhost), foco de teclado contra o canvas e contra o xterm. As extensões pedem VS Code recente (1.94 e 1.96). O host tem de acompanhar essa base para sempre, porque webview view, secondary sidebar, custom editor e o esquema de diff do Claude quebram em host atrasado.

Riscos. Licença: mesmo pelo Open VSX, Claude e Codex continuam “all rights reserved” / termos de uso. Não há grant para redistribuir o VSIX dentro do instalador do ADE. Antigravity ainda tem o `LICENSE.txt` ambíguo descrito acima. A extensão do Claude declara `untrustedWorkspaces.supported: false`. Um workbench aninhado também luta com o zoom: o canvas só mostra terminal a 100% porque escala quebra o widget; um IDE inteiro no nó tem o mesmo problema ou esconde o quadro.

Performance. Um VS Code ocioso já é um Chromium mais um Node. O ADE já é um webview. Aninhar os dois, e ainda deixar cada extensão subir o próprio `claude` / binário do Codex / `agy`, multiplica memória por janela. Vários nós não compartilham essa UI: a extensão é singleton da janela. N IDEs no quadro não é um desenho que a máquina do usuário aguente, e um IDE só não é o canvas.

Segurança e a flag do PR #46. O extension host é Node com processo filho, disco e rede. Ele não passa por `pty_create`, então não herda Job Object, `ADE_TAB_ID` nem a conta por variável daquela aba. As três extensões autenticam no próprio lugar (config do Claude, `CODEX_HOME`, keyring do `agy`). Um host compartilhado pela janela mistura contas que o ADE hoje separa por processo.

O [PR #46](https://github.com/tonalenar/ADE-AGS/pull/46) (rascunho, aberto, não está em `master`) põe `--dangerously-skip-permissions` só no `agy` interativo, via `launch_args` do catálogo, composto no `addTab` e na restauração da janela. A frota em `runs/antigravity.rs` continua sem essa flag. Se a extensão oficial substituir o PTY, essa composição deixa de valer: a extensão sobe o `agy` do jeito dela. A extensão do Claude tem o próprio interruptor, `claudeCode.allowDangerouslySkipPermissions`, descrito no manifesto como coisa de sandbox sem internet, e `claudeCode.initialPermissionMode` aceita `bypassPermissions`. Ligar isso dentro do IDE embutido abre uma porta que a frota fecha de propósito, e o ADE não vê a flag na linha de comando.

Canvas e bus. Peers, briefing de missão e `peer check` assumem uma TUI que recebe tecla e tem tela. O workbench não é essa TUI. O bus `ade-event` também não vê o que a extensão faz, a menos que se construa uma ponte. Aí o caminho A já pagou o custo do C e ainda carrega um IDE.

### B. Extension host próprio, sem o workbench

Implementar o suficiente da API do VS Code para carregar os três `extension.js`, e desenhar os webviews no React do ADE.

Esforço. O protocolo entre workbench e host tem centenas de serviços e muda a cada release do VS Code. As três extensões usam, no manifesto, sidebar, secondary sidebar, webview view, custom editor, comentário de hunk, atalho condicionado a contexto e, no Claude, um esquema de arquivo próprio para o lado direito do diff. Cobrir isso é escrever outro VS Code. Theia e o OpenVSCode existem porque esse trabalho é um produto, não uma biblioteca. Compatibilidade parcial significa extensão que abre e quebra no diff, que é a parte que a pessoa quer ver.

Riscos. Os mesmos de licença do caminho A, mais a tentação de ler o `extension.js` minificado para descobrir o protocolo privado. Os termos do Marketplace proíbem engenharia reversa da oferta. Este parecer não fez isso e um MVP não deve fazer.

Performance. Menor que um workbench completo se o host for só Node mais um webview, mas o processo Node e o binário do agente continuam por instância. Sem o workbench, cada chamada de API não implementada vira falha em runtime, difícil de testar sem as três extensões instaladas.

Segurança e PR #46. Igual ao A: o host fica fora do cerco do PTY. Injetar `claudeCode.initialPermissionMode` ou a flag do `agy` para “ficar igual ao terminal” copia o bypass para um lugar onde a missão não tem a tela de aprovação. O certo, se alguém insistir nesse caminho, é não passar `bypassPermissions` nem `--dangerously-skip-permissions`, e traduzir o pedido de aprovação da extensão para a fila que a frota já tem (`task_approvals`, nega se ninguém responde).

Canvas e bus. O nó deixaria de ser um PTY. `peers_of` continua valendo só se o processo ainda falar `ags` com `ADE_TAB_ID`. Nada na API do VS Code faz isso. Seria código nosso em volta do host, de novo o caminho C.

### C. Painel nosso, mesmos CLIs e protocolos, PTY como está

Não carregar a extensão. Falar com o binário que o usuário já tem, do jeito que a frota e o app-server já falam, e desenhar o painel no React do nó.

O que já existe e serve de base:

- Claude de frota: `claude -p --output-format stream-json`, `--permission-mode default` com `--permission-prompt-tool` quando há broker, e `acceptEdits` com prompts `none` quando não há ninguém para perguntar. Nunca `bypassPermissions` (`runs/agents.rs`).
- Codex de frota: `codex exec --json` e sandbox. Fora da frota, `runs/model_discovery.rs` já sobe `codex app-server --listen stdio://`, faz `initialize` e chama `model/list` e `account/read`. Stderr é drenado e não volta para a UI, porque pode carregar caminho de perfil.
- Antigravity de frota: perfil temporário, MCP com nome único, deny de comando e de unsandboxed, `--mode accept-edits`, sem `--dangerously-skip-permissions`. Eventos NDJSON com `conversation_id`, passo, resultado e uso.

Esforço. Um tipo de nó (ou um modo do nó) que não monta xterm. Um processo longo por aba, supervisionado no mesmo lugar do PTY para morrer com a aba. Eventos estruturados entram no bus com tópico novo, sem misturar com `pty-data-*`. A primeira fatia é só Codex, porque o cliente JSON-RPC já está no binário e o protocolo é o que a OpenAI mantém para cliente de terceiro. Claude e Antigravity entram depois, reusando o parser da frota, não um SDK novo.

Riscos. O app-server não é um contrato congelado: a própria OpenAI conta que a primeira versão não foi desenhada como API estável, e o doc marca métodos (plugins, por exemplo) como ainda não prontos para cliente de produção. O painel tem de fixar a versão do `codex` que testou e falhar fechado quando o método não existe. Para o Claude, o risco jurídico é embutir SDK e login; o caminho que permanece alinhado aos termos é o binário instalado pelo usuário, sem modificar e sem o ADE guardar o token. Para o Antigravity, não há app-server público equivalente: o contrato é o CLI `--print` / a TUI. Um painel interativo em cima de `--print` perde o que a TUI faz entre um turno e outro; isso tem de ser aceito na fase, não escondido.

Performance. Um processo de agente por nó, como hoje. Sem Chromium extra e sem Node de extension host. O painel React escala com o zoom do canvas; não sofre a regra dos 100% do xterm. Texto longo precisa de virtualização, o mesmo cuidado que o xterm já tem com scrollback.

Segurança e PR #46. O painel não compõe `launch_args`. Se o #46 entrar, ele vale para o terminal interativo do `agy` e só para ele. O painel do Antigravity, quando existir, usa a política da frota (deny explícito, aprovação na fila do ADE) e não a flag. Codex no painel responde aprovação pelo app-server (`on-request` / sandbox `workspace-write`), no mesmo espírito do `exec` atual, em vez de `--approve-for-me` herdado do nível `safe` da missão em terminal. Timeout continua negando, como o headless já faz. Conta continua sendo o env do processo (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`); o Antigravity continua na conta do sistema até existir seletor oficial.

Canvas e bus. O nó segue com id de aba, aresta e `ADE_TAB_ID`. `peer ask` vira um turno no protocolo, não um paste na TUI. `peer check` lê o último evento estruturado, não a tela. Missão em terminais pode continuar no PTY; a missão que quiser o painel é uma fase posterior, para não ter dois briefings. O bus ganha tópicos (`agent.turn`, `agent.approval`) ao lado dos `task.*` que já existem. Quem chega tarde usa `since` / `ags events wait`. A história curta de 2000 eventos não vira log: o transcript continua no disco do próprio CLI.

## Recomendação e MVP

Ficar no caminho C. Não carregar as extensões oficiais. Não vender code-server como “o canvas com VS Code”.

O MVP é um painel de Codex no canvas, ao lado do PTY, não no lugar dele.

1. **Contrato.** Um modo do nó Codex, opt-in, que sobe `codex app-server` com o env da conta da aba. Reusa o cliente de `model_discovery.rs` em vez de abrir um segundo dialeto. Versão do CLI registrada no log do nó. Se `initialize` falhar, o nó volta para o PTY e diz o motivo.
2. **Um fio.** `thread/start` e um `turn/start`. O painel mostra texto, chamada de ferramenta e diff como dado, no React. Aprovação de comando e de arquivo cai na fila que a frota já mostra; silêncio nega. Sem `--dangerously-skip-permissions`, sem sandbox `danger-full-access`, sem aprovar sozinho.
3. **Bus.** Cada evento do turno publica em `ade-event` com `tab` na carga e `seq`. `peer check` desse nó lê isso. `peer ask` de um vizinho manda um turno, só se a aresta existir. O PTY dos outros agentes não muda.
4. **Claude, depois.** Painel em cima de `claude -p --output-format stream-json` com o broker MCP que a frota já usa. Binário do usuário, sem Agent SDK vendido junto, sem tela de login própria. `bypassPermissions` fora. O modo terminal (`useTerminal` da extensão) já é o que o canvas faz; o painel só substitui a TUI quando a pessoa pede.
5. **Antigravity, por último.** Só com a política do run (perfil e deny), nunca com a flag do PR #46. Enquanto o painel não existe, o nó continua PTY. Se o #46 for mergeado, a flag fica restrita a esse PTY interativo e não vaza para o painel nem para `runs/antigravity.rs`.
6. **Fora do MVP.** Atalho “abrir esta pasta no VS Code / Antigravity” para quem quer a extensão oficial no editor dela. Isso não é integração: é sair do ADE.

O que não fazer no meio do caminho: vendor de VSIX no repositório, host parcial “só para ver se carrega”, e misturar a flag de permissão automática do terminal com o processo do painel.

## O que ficou de fora desta leitura

Não rodei as extensões. Não abri o `extension.js`. Não confirmei, num VS Code instalado, se o build do Marketplace e o do Open VSX são o mesmo byte a byte; as versões citadas são as que a API do Open VSX devolveu como `latest` nesta data. O Codex `26.5908.31748` vinha marcado como pre-release nesse alias. Números de download e a ordem das versões mudam; o desenho (host Node, webview, sem `browser`) é o que o manifesto fixa.
