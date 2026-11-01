# Modo chat (estilo T3 Code)

Uma terceira forma de ver o trabalho, ao lado das abas e do canvas: uma sidebar de conversas e, ao lado, a conversa aberta ou a tela de conversa nova. O layout segue o T3 Code (MIT): sidebar de 256 px, cabeçalho de 52 px, composer de vidro com cantos de 16 px e coluna de 736 px.

## Estado: F1 (casca), experimental

- Fica **desligado** por padrão. Para ligar: Configurações → Avançado → "Modo chat (experimental)".
- Ligado, aparecem:
  - o seletor `Chat | Abas | Canvas` no topo do chat;
  - um botão "Chat" na barra de abas;
  - o atalho **Ctrl+Shift+L**. Com o modo desligado, o acorde segue para o terminal.
- **Uma conversa é uma aba de agente** (a TUI real, num PTY). A conversa nova abre o agente com:
  - a pasta;
  - o modelo e o esforço (`withModel`, os mesmos flags das missões);
  - a conta ou pool (`resolveAccountChoice`);
  - a permissão e o Plano (ver a tabela abaixo).

  Depois manda o prompt quando a TUI fica pronta (`sendWhenReady`). A aba aparece também nas abas, no canvas e na CLI.
- O composer cola a mensagem na TUI e envia (`pasteIntoTab`).
- A sidebar lista os agentes abertos da janela (sem os terminais de shell), os mais novos primeiro.

## Timeline, permissões e painel (caminho A)

- **A conversa é lida do transcript do agente** (Claude Code e Codex), o mesmo arquivo que o canal estruturado já acompanha.
  - `canal/timeline.rs` transforma as linhas em itens: mensagens, falas, ferramentas (tipo, caminho, `+/−`, status, saída) e fins de turno.
  - O comando `conversation_timeline(tabId)` lê só o fim do arquivo (até 4 MB) e acha o arquivo pelo id da aba, nunca por um caminho vindo da janela.
  - O laço do canal avisa `cc-conversation-grew` quando o arquivo cresce, e a janela relê.
- **Desenho (prancheta 2):** cada turno tem a bolha da pessoa e o fold "Trabalhou por …" com as ferramentas e falas intermediárias. A resposta final e o cartão "N arquivos alterados" (com "Abrir diff") ficam fora do fold. Enquanto o agente trabalha, aparece "Trabalhando há …".
- **O terminal do agente** fica numa gaveta de 280 px (botão no cabeçalho), posicionada por slot e sem remontar. Agentes sem transcript continuam com o terminal como corpo da conversa.
- **Aprovações:**
  - O detector do canvas (`terminalPrompts.ts`) lê o diálogo da TUI.
  - O composer mostra Recusar / Sempre nesta sessão / Aprovar e manda a tecla da opção (`answerTerminalPrompt`).
  - O canal também avisa `cc-conversation-approval`, que a sidebar usa para o selo "Aprovação".
- **Parar:** com o agente trabalhando e a caixa vazia, o botão vira Parar e manda Esc à TUI.
- **Permissões** (os quatro modos do T3), passadas na abertura da conversa (`chatModel.withAccess`):

  | Modo | Claude Code | Codex | Gemini |
  |---|---|---|---|
  | Supervisionado | nada | nada | nada |
  | Aceitar edições | `--permission-mode acceptEdits` | — | `--approval-mode auto_edit` |
  | Auto (padrão) | o nível seguro das missões | o nível seguro das missões | o nível seguro das missões |
  | Acesso total | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

  - Plano: `--permission-mode plan`, só no Claude.
  - Um modo que o agente não tem nunca dá mais permissão do que a pedida.
- **Seletor (prancheta 3):**
  - popover de 360×346, com favoritos (no `localStorage`), agentes, modelos com busca e a conta no rodapé;
  - o esforço fica num menu à parte, ao lado do modelo.
- **Painel direito (540 px):**
  - **Diff:** o `git diff HEAD` da pasta, pelo comando `scm_working_diff`, relido quando o agente trabalha;
  - **Arquivos:** o `FilesView`;
  - **Maximizar:** o painel ocupa a área da conversa.
- **Sidebar (prancheta 1):**
  - busca, filtro por pasta, adicionar projeto e nova conversa;
  - cartões com o status ao vivo e o `+/−` da pasta;
  - "Concluídas", com as pastas fechadas para reabrir;
  - rodapé com Configurações, Pull requests (Forge) e Uso (Contas).

## Telas no visual novo

- **Telas cheias dentro da casca:** com o chat ligado, Configurações, Missões, Frota, Squads, Skills, Marketplace, Forge e Histórico abrem no lugar da conversa (`ChatPage`), não por cima (`RouteModal`). As rotas não mudam. Escape ou "Voltar ao chat" voltam à conversa.
- **Configurações (prancheta 5), a mesma tela em todos os modos:** nas Abas e no Canvas a página desenha a barra das seções (`SettingsSidebar`); no chat, a barra é a da casca, com os semáforos e o "Voltar ao chat". A barra tem três grupos, a busca, o selo "Novo" e o número de sugestões de memória pendentes na Memória. A busca acha também pelas abas e pelos ajustes de dentro (`SETTINGS_SEARCH`). A página tem título e subtítulo; as seções usam cartões com borda, linhas de 14 px, chave azul e segmentado. O visual antigo (a barra com ícones coloridos e a coluna de memória à direita) saiu.
- **Seção "Modo chat":** saiu de Avançado e virou seção própria (`chat`).
  - Ao abrir: o liga/desliga e o **modo inicial** (Chat, Abas ou Canvas; `uiStore.startMode`, aplicado na abertura por `startShell` e, para Abas/Canvas, pelo `AppShell` na pasta ativa).
  - Novas conversas: agente e permissões padrão, worktree, Plano e "sem terminal" (os mesmos valores que o composer lembra, `chatPrefs`).
  - Visual: a **largura da conversa** (Normal 736 px, Larga 960 px, Inteira; `chatLook.ts`, ao vivo).
- **Seções novas:** Dispositivos (as preferências do simulador iOS e o Android) e Worktrees.
- **Contas (prancheta 6):** no chat, os agentes em abas; as contas do escolhido num cartão com o estado e as barras de cota (janela atual e semana; cor por faixa em `accounts/meter.ts`); adicionar conta; os pools; e o gerenciador completo (limites, chaves, git) embaixo.
- **Decisões (prancheta 7):** no chat, duas colunas. À esquerda o provedor, a comparação e os pontos com o selo do modo (`POINT_MODE`: Sombra, Ajuda, Sugere, Decide, como na tabela do `docs/agentes/JEV.md`); à direita o resumo do modo sombra (`shadowSummary`) e onde o Jev age.
- **Espaços (prancheta 6):** nas outras telas a sidebar lista Conversas e os Espaços (`chatSpaces.ts`). Memória abre a seção das Configurações.
- **Painel direito (prancheta 8):** o Diff fixo e as superfícies abertas (`useChatStore.surfaces`), cada uma com o nome do que mostra (o host do navegador, o aparelho escolhido); o "+" abre as outras e cada aba fecha no "×". Design e os aparelhos são carregados sob demanda (puxam o canvas):
  - **Design:** o mesmo `DesignPanel` do canvas, com os designs da pasta da conversa;
  - **Simulador iOS (prancheta 9):** uma aba com o nome do aparelho. Em cima, o seletor ("iPhone 18 Pro · iOS 26 simulador"), o estado, o app aberto e "Reabrir app". No meio, a tela nativa (`SimulatorScreen`) numa moldura com as medidas da prancheta (`devicesModel.deviceFrame`). À direita, os controles: Início, Girar, Capturar (a captura vai para o composer como `@caminho`), Aparência, Localização, Face ID, Teclado e o "⋮" (bloquear, abrir URL, modo leve, ligar/desligar).
  - **Android (prancheta 10):** uma aba com o modelo. Em cima, o segmentado dos aparelhos ("Pixel 9 · API 36 · emulador", "Galaxy S25 · USB"), o estado e `adb · serial`. No meio, os quadros do `adb` com toque e deslizar. À direita: Voltar, Início, Recentes, Girar, Capturar, Volume, Logcat e o "⋮" (ligar um AVD).
  - **Chave dos agentes:** "Permitir que agentes controlem dispositivos" (rodapé das duas). Os aparelhos abertos no painel chegam ao `ags device` de qualquer agente (`devices_share`); com a chave desligada, o agente só vê (`shot`/`tree`).

## Conversa por protocolo (caminho B): Codex pelo `app-server`

Com o Codex, a conversa nova fala direto com o agente pelo `codex app-server`, sem TUI. Vale para as conversas novas e pode ser desligado em Configurações → Modo chat → "Codex, Claude Code, OpenCode e Antigravity sem terminal" (a mesma opção liga o Claude Code, o OpenCode e o Antigravity por protocolo, abaixo). Desligado, o Codex roda na TUI como os outros agentes. As conversas que já existem não mudam.

- **Backend (`src-tauri/src/conversa/`):**
  - `store.rs`: as tabelas `chat_thread`, `chat_run`, `chat_item` e `chat_request`. A migração é só aditiva, sem subir `user_version`.
  - `codex.rs`: um processo `codex app-server` por conversa, com JSON por linha no stdio. Ele sobe na primeira mensagem e retoma a thread do Codex (`thread/resume`) depois de reabrir o app.
  - `codex_map.rs` (puro): os itens do Codex viram o mesmo `canal::timeline::Item` da timeline lida do transcript; o acesso vira política de aprovação e sandbox.
  - `commands.rs`: `chat_threads`, `chat_thread_create`, `chat_thread_send` (começa um turno ou entra no que está em andamento com `turn/steer`), `chat_thread_items`, `chat_thread_requests`, `chat_thread_status`, `chat_thread_interrupt`, `chat_request_answer`, `chat_thread_retune`, `chat_thread_rename` e `chat_thread_settle`.
  - Evento `cc-chat-thread`, com os tipos `item`, `delta`, `phase`, `request`, `requestResolved`, `thread`, `error` e `closed`.
- **Acesso:**

  | No chat | `approvalPolicy` | Sandbox |
  |---|---|---|
  | Supervisionado | `untrusted` | `workspace-write` |
  | Auto | `on-request` | `workspace-write` |
  | Acesso total | `never` | `danger-full-access` |

  Trocar o acesso fecha o processo; a próxima mensagem retoma a thread com o sandbox novo. Modelo e esforço valem no próximo turno.
- **Front (`src/features/chat/structured/`):** o store ao vivo, os cartões (chave `thread:<id>`) e a `StructuredConversationView`. A tela usa a mesma `TimelineView`, o mesmo composer e os mesmos menus da conversa por TUI. Aprovações e perguntas se respondem nos botões do composer; parar interrompe o turno.
- **CLI e MCP (etapa 5):** `ags chat list|new|send|wait|show|stop|pending|open|settle` (Codex e Claude Code) e as tools `chat_*` nas abas (handlers em `src-tauri/src/ipc/commands/conversas.rs`, sobre o mesmo `conversa::api` da tela).
  - Uma conversa aberta por agente começa **supervisionada** (`access: ask`).
  - `chat wait` dorme no barramento (`chat.changed`), sem polling, até o turno acabar ou o agente pedir algo à pessoa. `reply` é a última fala DEPOIS da última mensagem da pessoa; terminou sem fala nova (erro, interrompido, processo caído), `reply` vem `null` e `stopped` traz o motivo (lido do `turnEnd`).
  - Responder às aprovações e perguntas do agente da conversa **não** tem comando: é da pessoa, na tela.
  - `chat open` liga a casca do chat e mostra a conversa (pela ponte do front, `cliBridge.ts`).
  - Papéis só de leitura (QA) recebem só `chat_list`, `chat_show`, `chat_wait` e `chat_pending`; tarefas da frota não recebem as tools do chat.

### Claude Code por protocolo

Com o Claude Code, a conversa nova fala com o agente por `claude -p` em stream-json, sem TUI. A opção é a mesma do Codex ("Codex, Claude Code, OpenCode e Antigravity sem terminal").

- **Protocolo (Claude Code 2.1.312, conferido no `--help`, no binário e em 2 turnos reais mínimos):** um processo por conversa, com `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode <modo>`, e `--model`/`--effort` quando escolhidos. É o mesmo protocolo que o Agent SDK usa: JSON por linha nos dois sentidos.
  - **Sessão:** a primeira abre com `--session-id <uuid>` escolhido pelo app; depois de fechar (reabrir o app, trocar o acesso), a próxima mensagem retoma com `--resume <uuid>`. Um `--resume` de sessão que sumiu fecha o processo antes de responder ao `initialize`: aí abre uma sessão nova, e a timeline guardada continua.
  - **Mensagens:** o app manda `{type: "user", message}`; o Claude devolve `assistant` (um bloco por linha, com o mesmo `message.id`), `user` (os `tool_result`), `stream_event` (os pedaços do texto, com `api_message_id` e `index`) e `result` (o fim do turno). O texto em pedaços e o item final têm o mesmo id (`<message.id>#<index>`).
  - **Aprovações:** com `--permission-prompt-tool stdio`, o Claude manda o `control_request` `can_use_tool` e espera `{behavior: "allow" | "deny"}`. "Permitir na sessão" devolve as sugestões do próprio Claude (`permission_suggestions`), sempre com `destination: "session"`: nada vai para os settings do projeto. `AskUserQuestion` chega pelo mesmo pedido e responde com `updatedInput.answers`.
  - **Parar:** o `control_request` `interrupt`. O turno acaba com `result` (`terminal_reason: "aborted_*"`) e vira fim de turno interrompido.
  - **Por que não a tool MCP da frota** (`--permission-prompt-tool mcp__ags__approve_tool_use`): ela passa pelo `ags mcp` e pelo broker, que servem tarefas desatendidas. Na conversa há alguém olhando, e o stdio já leva o pedido ao processo que mostra a tela, sem MCP, sem broker e sem tocar `ipc/`.
- **Acesso** (`--permission-mode`):

  | No chat | Modo do Claude |
  |---|---|
  | Supervisionado | `default` (pede aprovação de tudo que não é leitura) |
  | Aceitar edições | `acceptEdits` |
  | Auto | `auto`, o mesmo nível seguro das missões (`withAutonomy`) |
  | Acesso total | `bypassPermissions` |
  | Plano | `plan` |

  - O **Plano** fica guardado no próprio `access` da conversa (`plan`, só no Claude), sem coluna nova. Ele liga e desliga no botão Plano/Construir do composer; desligar volta a Supervisionado, nunca a um modo com mais permissão.
  - Sair do Plano é o pedido `ExitPlanMode`, com o plano no detalhe: "Aprovar o plano" segue em Supervisionado, "Aprovar e aceitar edições" segue em `acceptEdits`, "Continuar planejando" nega e o agente ajusta o plano.
  - Quando o modo muda do lado do Claude (saiu do Plano, aceitou edições na sessão), o `access` da conversa acompanha e a tela recebe o evento `thread` com o `access` novo.
  - Trocar modelo, esforço ou acesso fecha o processo (no fim do turno, se há um); a próxima mensagem retoma a sessão com as flags novas.
- **Backend:** `conversa/claude.rs` (o processo, com o mesmo evento `cc-chat-thread` do Codex) e `conversa/claude_map.rs` (puro: linhas em itens, `can_use_tool` em pedido, respostas, flags). O `api.rs` escolhe o motor pelo agente da conversa (`Engine::Codex` / `Engine::Claude`). As ferramentas viram itens pelo mesmo `canal::timeline::claude_tool` da timeline lida do transcript; o `ExitPlanMode` vira o plano.
- **Conta:** `accounts::env_for_account` (o `CLAUDE_CONFIG_DIR` da conta), como no Codex.

- **Ainda não:** ACP do Gemini e do Kimi (o motor do OpenCode já fala ACP e serve de base); reverter turno; anexos de imagem; subagentes (`Task`) aparecem só como a ferramenta, sem o que fazem dentro.

### OpenCode por protocolo (ACP)

Com o OpenCode, a conversa nova fala por `opencode acp` (Agent Client Protocol: JSON-RPC 2.0 por linha no stdio), um processo por conversa. É o mesmo desenho do Codex e do Claude Code, em `conversa/opencode.rs` (processo) e `conversa/opencode_map.rs` (puro).

- **Por que o ACP** (e não `opencode serve` ou `opencode run --format json`): é um protocolo bidirecional por stdio, como o `codex app-server`, sem porta nem servidor compartilhado; o `run --format json` é um processo por turno, sem permissão nem texto em pedaços (o fixture `runs/fixtures/opencode_stream.jsonl` só tem partes inteiras).
- **Conferido sem gastar cota** (OpenCode 2.2.1): `initialize` e `session/new` reais. Eles mostram `loadSession`, `sessionCapabilities.resume`, `configOptions` (`model` com `provedor/modelo`, `effort` que muda com o modelo, `mode` com `build` e `plan`) e que o `OPENCODE_CONFIG_CONTENT` do ambiente vale para o `acp` (o modelo da config aparece no `session/new`). **Não conferido:** um turno real (texto, ferramentas, permissões); esses avisos seguem a especificação do ACP e estão no teste `e2e_opencode_acp_um_turno_real` (`#[ignore]`, `CC_E2E_OPENCODE_MODEL`).
- **Sessão:** `session/new` na primeira mensagem; depois de reabrir o app, `session/resume` (sem reenviar o histórico), com `session/load` de reserva (os avisos de replay são ignorados) e, se a sessão sumiu, uma nova (a timeline guardada continua). O id vai em `chat_thread.remote_id`.
- **Mensagem e fila:** `session/prompt` responde só no fim (`stopReason`). O ACP não tem "entrar no turno": a mensagem que chega com o turno em andamento fica numa fila e começa o turno seguinte.
- **Parar:** o aviso `session/cancel`; os pedidos de permissão em aberto respondem "cancelado".
- **Itens:** `agent_message_chunk` e `agent_thought_chunk` viram os `delta` do fluido e os itens `assistant`/`reasoning` (o texto fecha quando chega outra coisa); `tool_call`/`tool_call_update` viram a ferramenta equivalente do Claude (`execute` → comando, `edit` com `diff` → edição com `+/−`, `read`, `search`, `fetch`, `think` → subagente); `plan` vira o plano do turno; `usage` da resposta vira os tokens.
- **Aprovação:** o `session/request_permission` vira uma linha de `chat_request` (as opções do protocolo ficam em `options.acp`). Permitir → `allow_once`; "Sempre nesta sessão" → `allow_always` (cai em `allow_once` se o OpenCode não oferece); Recusar → `reject_once`. Nunca dá mais permissão do que a pedida.
- **Acesso:** o OpenCode não tem aprovação por flag; o acesso vira a política `permission` da configuração dele, passada em `OPENCODE_CONFIG_CONTENT` na abertura do processo:

  | No chat | `edit` | `bash` | `webfetch` | Modo |
  |---|---|---|---|---|
  | Supervisionado | ask | ask | ask | build |
  | Aceitar edições | allow | ask | ask | build |
  | Auto | allow | ask | allow | build |
  | Acesso total | allow | allow | allow | build |
  | Plano | ask | ask | ask | plan (read-only) |

  O OpenCode não tem sandbox nem classificador, então o "Auto" aqui é: edita e busca na web sozinho; comando ainda pergunta.
- **Modelo e esforço:** `session/set_config_option` na abertura (o modelo antes, porque o esforço depende dele). Um modelo que o OpenCode não lista dá erro claro; um esforço que o modelo não tem fica no padrão. Trocar modelo, esforço ou acesso fecha o processo (no fim do turno) e a próxima mensagem retoma a sessão.

### Antigravity por protocolo (`agy --print` em stream-json)

Com o Antigravity, a conversa nova roda `agy --print <mensagem> --output-format stream-json`, **um processo por turno** (`conversa/agy.rs` e `conversa/agy_map.rs`).

- **Por que um processo por turno:** o `agy` tem `--input-format stream-json` (vários turnos num processo), mas o formato das mensagens de entrada (`{"event": …}`) não está documentado e eu não quis adivinhá-lo. Com `--conversation <id>` o `-p` continua a mesma conversa (o `conversation_id` vem do `init` e do `result` e fica em `remote_id`), então a conversa se comporta igual; só não há processo vivo entre os turnos. Não há ACP no `agy`.
- **Conferido sem gastar cota** (agy 1.4.11): `--help`, o changelog embutido, o `-p "/usage"` (o CLI responde sozinho: confirma o envelope `{"event": …}` e o `result` com `usage`) e o parser que as tarefas já usam (`runs/antigravity.rs`: `step_update` com `step_index`, `state`, `step_type`, `text_delta`, `tool_name`, `parameters`). **Não conferido:** um turno real; os campos das ferramentas (`tool_info`, `parameters`) vêm do changelog, e o mapeamento é tolerante a nomes que não conheço (vira uma ferramenta genérica com o nome). Teste `e2e_agy_um_turno_real` (`#[ignore]`, `CC_E2E_AGY=1`).
- **Itens:** `step_type: agent_response` com `text_delta` vira os `delta` e a fala; passos de pensamento viram `reasoning`; os outros viram ferramentas (`run_command` → comando, `view_file` → leitura, `edit_file`/`write_to_file` → edição, `grep_search` → busca, `read_url_content` → web, `call_mcp_tool` → "servidor: ferramenta"); o `usage` do `result` vira os tokens; `finished_reason` (`interrupted`, `print_timeout`, `error`) decide o fim do turno.
- **Sem aprovação:** no modo `-p` o agy não pergunta. O que precisaria de aprovação é negado e vem em `denied_actions`, que a conversa mostra como ferramentas negadas. Por isso esta conversa **nunca gera pedidos de aprovação**.
- **Acesso:** Supervisionado = nenhuma flag (o que pede aprovação é negado, então é quase só leitura); Aceitar edições = `--mode accept-edits`; Auto = `--mode auto`; Plano = `--mode plan`; Acesso total = `--dangerously-skip-permissions`. As barras da mensagem não viram comandos do CLI (`--disable-slash-commands`).
- **Modelo e esforço:** `--model` (os ids de `agy models`) e `--effort`; valem no turno seguinte, sem fechar nada.
- **Fila e parar:** a mensagem que chega com o turno em andamento fica na fila; parar mata o processo do turno.

## Texto chegando e tipografia

- **Por protocolo, os pedaços reais.** O evento `delta` do `cc-chat-thread` leva `itemId`, `delta` e `kind` (`assistant` ou `reasoning`) e vai só à janela: o banco grava o item completo, como antes.
  - **Codex:** `item/agentMessage/delta` (a resposta) e `item/reasoning/summaryTextDelta` (o resumo do raciocínio); `item/reasoning/summaryPartAdded` com índice > 0 vira a linha em branco entre as partes, como no item final. O `item/reasoning/textDelta` (raciocínio cru) fica de fora. Mapeamento puro em `codex_map::delta_of`.
  - **Claude Code:** com `--include-partial-messages`, os `stream_event` `content_block_delta` de `text_delta` e `thinking_delta`, com o id do bloco (`api_message_id` + `index`), o mesmo do item final (`claude_map::delta_of`). O CLI já junta pedaços seguidos do mesmo bloco antes de mandar, então chegam em rajadas.
  - **Na janela:** os pedaços de um quadro viram uma atualização só do store (`createFrameBatcher` com `requestAnimationFrame`); qualquer outro evento entrega os pendentes antes, para manter a ordem. Os rascunhos ficam por item (`ThreadLive.drafts`) e entram na timeline como itens comuns (`withDrafts`); o raciocínio chegando alimenta a linha viva.
- **Revelar (`timeline/streaming.ts`, `useRevealedText`):** a fala do agente que chegou depois de abrir a conversa aparece palavra a palavra, a ~160 caracteres por segundo, acelerando para nunca levar mais de 1,5 s pelo que falta. Vale para os rascunhos do protocolo e para as mensagens inteiras do transcript (TUI). O histórico (o que estava na primeira leitura, ou com carimbo de mais de 10 s antes de abrir) aparece inteiro. O progresso fica por id, então o rascunho que vira item final continua de onde parou. Com `prefers-reduced-motion`, aparece tudo de uma vez.
  - **TUI:** o transcript do Claude Code e do Codex só grava o bloco inteiro; hooks e statusline não trazem o texto parcial. Por isso a TUI usa só o revelar.
- **Cursor e rolagem:** enquanto o texto chega ou aparece, um cursor discreto no fim (`cc-stream-caret`, sem piscar com movimento reduzido). A rolagem acompanha o tamanho do conteúdo (`ResizeObserver`) se a pessoa estava no fim.
- **Tipografia (a escala do app do Claude):** a raiz da casca leva `cc-chat-type`, que troca a família (a pilha de reserva do Claude; a Anthropic Sans é proprietária e não vem junto) e os pesos (semibold 580, bold 600). Os tamanhos são tokens do `@theme` (`text-chat-prose` 16/24, `text-chat-ui` 14/20, `text-chat-heading` 15/20, `text-chat-title` 22/28, `text-chat-code` 13/19, `text-chat-note` 13/17, `text-chat-caption` 12/16). A fala do agente usa o `Markdown` com `tone="chat"`. As telas que também aparecem nas Abas (Configurações, a barra das seções, o botão Chat da barra de abas) mantêm os tamanhos; dentro da casca herdam só a família e os pesos.

## Agente trabalhando e permissões (pranchetas 13 e 14)

- **Linha viva** acima do composer (`LiveActivity.tsx`, lógica pura em `activityModel.ts`): três pontos de 5 px (pulso de 1,2 s; parados com `prefers-reduced-motion`), a atividade ("Rodando testes", "Editando frameBridge.ts", "Pensando…"), o tempo e os tokens do turno e "Ver o que está fazendo" (os dois últimos comandos e o raciocínio mais recente). `role="status"`; o tempo fica fora do anúncio.
  - **De onde vem:** os itens da conversa. A timeline ganhou os itens `reasoning` (o `thinking` do Claude, o `agent_reasoning`/resumo do Codex) e `usage` (os tokens de cada chamada: no Claude, entrada + cache + saída por mensagem; no Codex, o `token_count` do transcript ou o `thread/tokenUsage/updated` do app-server, com a base do turno em `codex_map::TurnTokens`), e o campo `plan` nas ferramentas `todo` (TodoWrite, `update_plan`, `turn/plan/updated`). Nada disso aparece no fio; `ags chat show` não lista os `usage`.
  - **Sidebar e cabeçalho:** a TUI usa o estado do canal (`turnStartedAt` e a ferramenta pendente, em `liveStore.turn`), sem ler a timeline de cada aba; a conversa por protocolo, os itens que chegam pelo evento.
- **Plano do turno** (`PlanCard`): "Plano · 2 de 4", o passo atual em destaque e os concluídos riscados, logo abaixo da mensagem do turno em aberto.
- **Fila:** ⏎ envia na hora; ⌘⏎ (Ctrl+⏎ fora do macOS) põe na fila com o agente trabalhando, e o `queueRunner` manda a próxima quando o turno acaba (TUI: quando o canal diz ociosa), uma por turno; um pedido esperando a pessoa segura a fila. O composer mostra "Fila: N".
- **Permissões, um store só** (`permissions/`): as aprovações das conversas por protocolo (`chat_request`), os diálogos das TUIs (`terminalPrompts`, lidos de todas as abas de agente pelo `PermissionsManager`) e as aprovações da frota (`runs`) viram o mesmo `PendingAsk` (`askSources.ts`), com agente, conversa, tipo (comando, edição, rede), detalhe, pasta, risco e o que mexe. Responder usa o caminho de cada fonte (`chat_request_answer`, `answerTerminalPrompt`, `decideApproval`).
  - **Risco** (`riskOf`, puro): leitura é baixo; instalar e o resto é médio; `git push`, `rm -r`, `sudo`, publicar, `--force` são altos. Edição dentro da pasta é baixo; fora ou em arquivo sensível, médio; sensível fora, alto.
  - **Cartão no fio:** Negar (N), Responder… (nega e manda o texto ao agente), "Sempre permitir <padrão>" e Permitir (⏎). Substitui os botões de aprovação do composer; perguntas e a saída do Plano seguem no composer.
  - **Caixa "Permissões"** (⇧⌘A, ou Ctrl+Shift+A; e o aviso "N agentes esperando você" na sidebar): filtros com contagens, J/K, Permitir/Negar, Abrir conversa, Negar todos e Permitir os de baixo risco. Divide o lado direito com o painel: abrir um fecha o outro.
  - **Regras "Sempre permitir":** nos settings (`chat.permissions.rules`, sem tabela nova), por tipo, padrão e agente; editáveis em Configurações → Permissões. Um comando composto só casa se todas as partes casarem; risco alto nunca é automático.
  - **Aviso do sistema:** pedido novo com o app sem foco vai pelo `chat_permission_notify` (o `notifier::show_custom` das missões, com `notifications.enabled`). A frota segue com o aviso dela.

## Time de agentes (pranchetas 15 e 16)

- **O modelo:** uma conversa (aba de TUI ou conversa por protocolo) vira o **Orquestrador** de um time; os integrantes são outras conversas (novas ou já abertas), cada uma com papel (UI, Backend, Testes, Revisor…), modelo, política (Acesso total, Aceita edições, Supervisionado/"Pede tudo", Só leitura) e, quando o time a abriu, um worktree na branch `team/<papel>`. Um agente está em um time só.
- **Backend (`src-tauri/src/chat_team/`):** as tabelas `chat_team` e `chat_team_member` (só aditivas, criadas sob demanda, sem subir `user_version`); `api.rs` (criar, ligar, desligar, papel, política, o fio); os comandos `chat_team_*` e o evento `cc-chat-team`. O chat da equipe e as entregas de um time usam o escopo `t:<id>` (`missions::messages::scope_of`).
- **O canvas é a autorização:** ligar alguém faz a tela pôr a coroa no orquestrador, a corda até o integrante e o papel no nó (`team/teamCanvas.ts`), como numa missão; abas do time vão para o canvas do orquestrador. Uma conversa por protocolo não tem nó: a corda dela (`thread:<id>`) fica no canvas da pasta e o `reconcile` a mantém.
- **Mensagens:** `ags peer tell/ask/deliver` alcançam as conversas por protocolo do time (`ipc/commands/team.rs`): a mensagem entra na mesma fila (`peer_messages`) e vai como mensagem da conversa, depois do turno em andamento. O processo da conversa recebe `ADE_TAB_ID=thread:<id>` e o `ags` no PATH, para responder.
- **CLI e MCP:** `ags team list|create|link|unlink|role` e as tools `team_*`. Só o orquestrador liga, e só conversas da pasta dele; o agente nunca aumenta a política de ninguém (no máximo `ask`); desfazer o time é da pessoa.
- **Tela (`src/features/chat/team/`):** o painel Time (`TeamPanel`, a aba "Time" do painel direito) com o formulário de ligar e o arrastar da sidebar; os cartões de delegação e as entregas no fio do orquestrador (`TeamThreadFeed`); o segmentado "Time | Só o orquestrador" e o @agente (`TeamComposer`); o grupo do time na sidebar (`TeamSidebar`); o selo "Orquestrador · X" (`TeamHeaderBadge`).
- **Onde aparece:** a aba "Time" do painel direito abre sozinha ao abrir uma conversa que está num time (uma vez por conversa); a sidebar agrupa os integrantes sob o orquestrador com o selo "TIME · N"; o cabeçalho mostra "Orquestrador · X"; o composer do orquestrador tem "Time | Só o orquestrador" à esquerda e o menu do @agente; o fio termina com os cartões das delegações e o resumo das entregas.
- **Permissões:** `team/teamPermissions.ts` diz de quem é o pedido (papel, política, time) e o que a política decide sozinha. O `PermissionsManager` aplica a política antes das regras "Sempre permitir": só leitura nega (e diz ao agente por quê), o que a política deixa passa sozinho, o resto vai às regras e à pessoa; risco alto nunca é automático. O cartão e a caixa mostram o papel e a política (`TeamRoleTag`).

## Retomada, fila e avisos na timeline (etapa 3 do harness)

- **Retomar uma sessão que falha não esquece em silêncio** (`conversa/resume.rs`): o erro de `--resume`/`thread/resume`/`session/resume` é `Gone` (a sessão não existe: abre outra), `Transient` (2 retentativas com pausa curta; se persistir, abre outra), `Timeout` (NÃO abre outra: a sessão pode existir; falha e a pessoa tenta de novo) ou `Fatal` (o processo não sobe, ou modelo/modo não aplicam: falha). Ao abrir outra, a timeline recebe um item `notice` (`resumeLost`) e a tela diz que o agente recomeçou sem o histórico; o id da sessão anterior só é trocado depois de a nova abrir.
- **OpenCode falha fechado** em modelo, esforço e MODO: um erro ao aplicar recusa a abertura (as permissões nunca divergem do que a tela mostra). O esforço que o modelo não oferece fica no padrão, mas vira um `notice` (`optionIgnored`). Um OpenCode que nem lista a opção `mode` não tem o que mostrar errado (as permissões valem pelo ambiente do processo).
- **A fila do agy e do OpenCode** (`turn::Lane`: turno + fila sob UMA trava) só grava o item `User` quando o turno da mensagem começa; a tela a mostra como pendente até lá (sem o prazo de 2 min enquanto o agente trabalha). Se interromper ou fechar descarta a fila, cada mensagem vira um `notice` `queueDropped` («não enviada», com o texto e «Reenviar»).
- **Uma trava de abertura por conversa** (`resume::start_gate`), não uma por motor: um agente lento no `initialize` não segura as outras conversas.
- **Item `notice`** (`ItemKind::Notice`; `label` = código): linha própria no fio, fora dos turnos. A mensagem da pessoa no meio de um turno (steer, fila) fecha o turno anterior como «superado» (`TurnEnd.superseded`), e o fim de verdade vai para o turno que tem a resposta.
- **@menção do orquestrador**: a mensagem aparece como pendente na conversa que a pessoa olha, o erro de envio aparece ali, e, numa conversa por protocolo, o resumo do time só conta como entregue depois de o backend aceitar o envio (na fila do composer e numa aba, não há resposta a esperar: conta ao enfileirar/entregar).

## Permissão decidida no backend (etapa 3, parte B)

A política do integrante e as regras «Sempre permitir» da pessoa são aplicadas pelo BACKEND (`conversa/permission.rs`, `chat_team/permission.rs`), não mais pelo React: a decisão vale com a casca do chat fechada, com a conversa em segundo plano e depois de recarregar a janela.

- **Na chegada** (`on_arrival`, nos três motores): o motor monta o pedido INTEIRO (`Subject`: o comando completo, não o título, que guarda só a primeira linha), grava-o em `chat_request.subject` e decide: política do integrante (`model::decide`, que pode negar) e depois as regras. `Allow`/`Deny` respondem ao agente na hora; o resto fica `pending` e vai à tela.
- **Nunca automático**: risco alto (push, `rm -r`, `sudo`, `--force`, `curl | sh`…), perguntas do agente e a saída do Plano. Falha de leitura (time, regra) = a pessoa decide. Um pedido sem `subject` (de antes desta versão) nunca é decidido sozinho. Regra com escopo de papel ou de time (`role`, `team_id`, preparados) ainda não decide nada.
- **Só a pessoa cria regras**: tabela `chat_permission_rule` (`origin` só `person`), comandos Tauri chamados pela tela; nenhum comando de CLI/MCP escreve regra (teste de contrato em `chat_team/test.rs`). As regras antigas dos settings (`chat.permissions.rules`) foram COPIADAS uma vez, sem apagar o setting.
- **Interruptor por time** (`chat_team.auto_decide`, padrão ligado; «Não decidir sozinho» no painel do time): desligado, tudo vai à pessoa.
- **Varredura** (`chat_requests_sweep`): reaplica a decisão aos pendentes de todas as conversas ativas ao montar a janela, ao criar/mudar uma regra e ao religar o time. No arranque do app não há pendentes (o agente morre com o app e `sweep_orphans` os expira).
- **Auditoria**: `chat_request.decided_by` (`person`, `policy`, `rule:<id>`) e `decided_why`; o aviso `requestResolved` leva `by`/`why` e `ags chat pending` lista os últimos (`decided`).
- **Caminhos** (`resolve_path`, TS e Rust): resolvidos por TEXTO antes de tudo: `.` e `..` resolvidos, `//` e `\` como `/`, letra de disco do Windows sem diferenciar maiúsculas. O `..` que sobe acima da pasta, `~`, `$VAR`, `%VAR%` e crase são FORA (e sensíveis, se não se entendem); a edição só casa regra se estiver provadamente dentro, pelo caminho normalizado. O backend ainda confere os **links simbólicos no disco** (`Subject.escapes`): um link para fora da pasta conta como fora.
- **Comando por dentro** (`analyze_command`): separa por `&&`, `||`, `|&`, `;`, `|`, `&` isolado, `\r` e `\n`; os redirecionamentos que escrevem (`>`, `>>`, `&>`, `>|`) são acusados (menos `/dev/null` e `2>&1`); crase, `$`, `<(`, `>(`, heredoc, barra invertida e aspas no meio de palavra (`r'm'`) não se interpretam. Regra nunca casa nem o risco é «baixo» com isso. Risco alto, por parte e atrás de `xargs`/`command`/`sh -c`: `rm` com qualquer flag recursiva/forçada, `git` com opções globais antes do subcomando, `chmod`/`chown -R` e modos como 777, `find -delete`, `sudo`/`doas`, e `mv`/`cp`/`ln`/`tee`/`sort -o`/redirecionamento para caminho sensível fora da pasta.
- **«Só leitura» é uma lista curta**: `ls`, `cat`, `rg`, `git status|diff|log…`, etc., sem as opções que rodam ou escrevem (`rg --pre`, `find -exec`, `sort -o`, `git -c`). `env x`, `xargs`, `sh -c`, `less`/`man` e os executores de código do repositório (`bun run test`, `cargo test|build|clippy`, `vitest`: scripts, `build.rs` e testes que o agente acabou de editar) NÃO são baixo risco (continuam podendo ter regra da pessoa).
- **Uma resposta só ao agente** (`conversa/answer.rs`): o pedido é RESERVADO no banco (`claimed_at`, só se `pending`) antes de responder; quem perde não envia, o envio que falha devolve a reserva, e a decisão da pessoa vence a automática que chega junto.
- **Ferramenta de fora do shell** (MCP, `Task`, ferramentas do OpenCode que não são `execute`): `Subject.foreign`. Nenhuma regra de shell a casa; só o acesso total a libera, e só com a flag do time «Acesso total libera ferramentas de fora do shell» (`chat_team.allow_tools`, desligada por padrão).
- **Mesmo veredito nos dois lados**: as fixtures `src/features/chat/permissions/fixtures/permission-cases.json` (geradas do TypeScript) são lidas pelo vitest e pelo `cargo test`. TUI e frota seguem decididas na janela (`decidedByBackend`).

## Anexos: colar, arrastar, miniaturas

O composer do chat (conversa aberta, "Nova conversa" e mensagens de time) aceita anexos como o Claude Code:
Cmd/Ctrl+V cola a imagem do clipboard e arquivos copiados (lista `text/uri-list`); arquivos e pastas do Finder
soltos na coluna do chat inteira (realce "Solte para anexar"); o clipe usa a mesma regra. Eles aparecem como
miniaturas acima do texto (imagem = cartão com prévia; arquivo/pasta = chip com nome e tamanho; "×" com mouse
ou foco) e, na mensagem enviada, acima do balão; clicar numa imagem a amplia (visualizador com Esc, clique fora e
setas). Enviar só com anexos vale; o mesmo caminho duas vezes vira um só. O bloco do composer cresce com o texto e
as miniaturas até 40% da janela e rola por dentro, sem barra, com o enviar sempre à vista.

**Segurança.** A tela manda só CAMINHOS que a pessoa colou, soltou ou escolheu. O backend (`conversa/attach.rs`)
só faz `stat` neles (`chat_attachment_inspect`) e só lê imagens (`png/jpg/webp/gif`) para a prévia
(`chat_attachment_read`, até 20 MB) ou para o Claude (até 5 MB cada, 8 por mensagem). Pasta = só o caminho
(nada é listado). Imagem colada vai para `~/.ags/tmp/pasted` (`save_pasted_image`, 700/600, limpa em 24 h).

**Limites.** 10 anexos por mensagem; imagem até 20 MB; outros arquivos até 100 MB (o agente os lê pelo caminho);
soma de 200 MB. O que passa do limite fica de fora COM aviso; erro de leitura vira aviso; o texto digitado nunca se perde.

**Como cada motor recebe** (decisão; o caminho no texto é o fallback de TODOS e nunca é omitido):

| Motor | Caminho no texto | Imagem em linha |
|---|---|---|
| Claude Code (stream-json) | bloco `[Anexos]` | sim: blocos `image` base64 antes do texto (≤ 5 MB, ≤ 8) |
| Codex (`app-server`) | bloco `[Anexos]` | não: o item `localImage` do `turn/start` não foi verificado neste app |
| OpenCode (ACP) | bloco `[Anexos]` | não: `promptCapabilities.image` ainda não é lida |
| Antigravity (`agy -p`) | bloco `[Anexos]` | não |
| Abas com TUI | `@caminho` no fim do texto | não (a TUI lê pelo caminho, como ao soltar no terminal) |

O bloco é `[Anexos]` + uma linha `- imagem|arquivo|pasta | nome | bytes | caminho` por anexo, no fim do texto.
Como ele fica na mensagem guardada pelo motor, a bolha o lê de volta (`splitAttachmentBlock`) e mostra as
miniaturas ao reabrir a conversa, em qualquer motor, sem campo novo no banco. Uma imagem colada é limpa em 24 h:
depois disso a miniatura mostra "indisponível" (o caminho continua na mensagem). Mensagens de time (`@menção`,
"Time | Só o orquestrador") levam os anexos pelo mesmo caminho.

## Fala do agente × mensagem da pessoa (acabamento)

- **Balão só do usuário.** A mensagem da pessoa tem balão (`rounded-2xl`, `px-4 py-2.5`, fundo cinza translúcido,
  à direita, até 85% da coluna, "Mostrar mais" ao passar de ~8 linhas). A fala do agente fica SEM balão: texto
  corrido, com o logo e o nome acima na primeira fala depois da pessoa e sempre que a voz muda (`speakers.ts`);
  falas seguidas da mesma voz (com ferramentas no meio) não repetem a linha. **Aproximação**: sem o Claude desktop
  à mão, raio, padding e largura seguem o desenho já usado; ajustar em `timeline/Bubbles.tsx` se a comparação lado a
  lado pedir.
- **Mensagem entre agentes.** O envelope cru (`[Mensagem #68 de X via ADE AGS]`, a frase de aviso, a tag
  `untrusted_data`, a dica de resposta) só existe no que vai ao agente e no banco; a tela mostra o logo e o nome de
  quem mandou (sem balão) e o conteúdo. O pedido tipado (`X pediu sua ajuda nisto. Tarefa: … Contexto: …`) vira a
  tarefa e, em negrito, só os campos preenchidos (valores-padrão somem). O número da mensagem (`#68`, do
  `ags peer receipt`) fica só na dica (tooltip). Ver `timeline/peerEnvelope.ts`.
- **Perguntas.** O cartão «O agente fez uma pergunta» de uma conversa por protocolo responde ao clique enquanto a
  pergunta espera (as opções são botões); respondida, vira registro. Listas em texto do agente nunca viram botão.
  Em abas com TUI o cartão continua levando ao terminal.
- **Rolagem.** O Resumo solto fica num dock de altura fixa em coluna flex (`SummaryDock`); sem isso o miolo crescia
  com o conteúdo e a roda não rolava.
- **Composer.** A altura segue o texto e também a largura da caixa (`ResizeObserver`): abrir o painel direito
  refaz a altura sem digitar.

## Trocar de agente na mesma conversa (como o T3 Code)

Em uma conversa por protocolo (Claude Code, Codex, OpenCode, Antigravity), o seletor de modelo mostra o trilho de
agentes instalados. Escolher OUTRO agente troca quem responde NESTA conversa, com confirmação a cada troca. Vale também
para o orquestrador e os integrantes de um time. Abas com TUI ficam de fora (o terminal é do usuário).

- **Regras.** Só entre turnos e sem pedido do agente esperando resposta (`chat_thread_switch_agent`, `conversa/troca.rs`).
  Mesmo id, pasta, título, linha do tempo, fila de mensagens (`thread_outbox`) e time. O acesso vira o equivalente do
  motor novo (o Plano não existe no Codex: vira Supervisionado, e o aviso diz); o esforço zera; a conta do agente
  antigo não vale no novo (conta principal ou a escolhida).
- **Sessão nativa.** A do agente que sai fica guardada em `chat_thread_native` (aditiva, nada apaga). Voltar a um agente
  já usado retoma a sessão dele (na mesma conta) e leva só o resumo do que aconteceu fora (delta); um agente novo, ou
  de outra conta, recebe o resumo completo.
- **Resumo (`conversa/handoff.rs`).** Determinístico, sem gastar cota (como o T3 Code): pedido original, falas mais
  recentes sob um teto (24 mil caracteres, as mais antigas saem e o corte é dito), arquivos alterados, plano e pergunta
  sem resposta; sem raciocínio escondido. É DADO, nunca instrução: dentro do bloco `untrusted_data` do app, começando por
  `[ADE AGS]`. Vai na frente da PRÓXIMA mensagem da pessoa (não é um turno à parte) e só sai da pendência quando a
  mensagem foi enviada de fato. A tela esconde o bloco (termina na marca `[fim do contexto da conversa anterior]`).
- **Timeline.** Aviso persistente `agentSwitch` («Agora com Codex · modelo» e o que o agente novo recebeu); cada fala do
  agente leva o logo e o nome de quem a disse (`voicesByItem`); o histórico antigo continua à vista.
- **Time.** `chat_team.agent_id`/`chat_team_member.agent_id` e o rótulo `Agente · Papel` acompanham a troca.
- **ai-memory.** É por motor (Claude por processo; os demais sem suporte): o estado é zerado e recalculado ao abrir.
- **Anexos.** O bloco `[Anexos]` e os caminhos continuam no texto; imagem em linha só se o motor novo for o Claude.
- **Coordenação com o pool de contas** (`pool-contas`, `conversa/pool.rs`): o resumo dela (`handoff_text`) é o mesmo
  conceito com outra moldura («conta anterior»). Quando os dois PRs entrarem, `pool.rs` pode chamar `handoff::resumo`
  (parametrizado por quem sai e quem entra) em vez da função própria; os dois tocam `api.rs::send_mode`, `store.rs`,
  `mod.rs` e `NoticeRow.tsx`, então o merge pede conferência.

## Acabamento (build local do PR 270/271)

- **Resumo.** Sem lugar ao lado da conversa (janela estreita), o Resumo passa a flutuar POR CIMA dela (`summaryPlacement`:
  `beside` / `overlay` / `none`). Antes sumia: o botão «Resumo (R)» ficava marcado sem painel e ligar/desligar não trazia nada.
- **Ações sob a mensagem.** Hora relativa («há 24 minutos») e botões só ao passar o mouse ou focar (`MessageActions`): copiar
  (texto limpo, sem anexos nem envelope) na pessoa e no agente; «editar e reenviar» na pessoa devolve o texto ao campo
  (não cancela nada). Ficam para depois: bifurcar a conversa daquele ponto (o `handoff.rs` já serve de base), fixar e ler em voz alta.
- **Limites de uso.** O cartão lista TODAS as contas conectadas dos agentes que expõem a cota (Claude, Codex e Antigravity),
  as da conversa primeiro, cada uma com a janela atual e a semana; «não medido» só para o agente que não expõe a cota. O
  Antigravity sem perfil usa a mesma leitura do canvas (`agy /usage`, por grupo de modelos). Cursor: sem fonte sem ler o token
  de outro app (ver `.plans/cursor-motor/DESENHO.md`).
- **Trocar de agente e aprovação.** O Antigravity por `-p` não tem tela de aprovação: em Supervisionado ele NEGA o que pediria
  aprovação. A confirmação da troca e o aviso do fio dizem isso (`noApproval`); para liberar, mude o acesso.

## Como não derruba terminais

- O workspace continua montado por baixo da casca do chat:
  - topo, riel, painel de workspaces e barra de status ficam `hidden`;
  - o canvas fica `visibility: hidden`, porque os portais dele são navegadores.
- O terminal da conversa **não** é montado pela tela do chat:
  1. `ConversationView` mede o espaço que reserva e publica em `useChatStore.slot`.
  2. `placementsFrom` (com `chat`) mostra só a aba ativa nesse retângulo (`CHAT_GROUP`).
  3. O `TerminalPanel` posiciona a TUI ali, do mesmo jeito que o canvas faz com `liveRects`.
- Trocar de modo não muda `key`, pai nem ponto de montagem de nenhum `<Terminal>`.
- No chat, o `TerminalPanel` fica transparente e sem pegar o ponteiro (como no canvas). A área de abas fica acima da casca (`z-index 20`, `pointer-events: none`), e só o terminal visível recebe cliques.

## Arquivos

| Onde | O quê |
|---|---|
| `src/app/uiStore.ts` | `chatMode` (flag), `shellMode` (`chat` / `workspace`), `chatShellOn`, `useChatShell` |
| `src/features/chat/` | `ChatShell`, `ChatSidebar`, `NewConversation`, `ConversationView`, `ChatComposer`, `AgentModelPicker`, `AccessMenu`, `ShellModeSwitch`, `ChatEntryButton`, `ChatModeSetting` |
| `src/features/chat/ChatPage.tsx`, `ChatPageSidebar.tsx`, `chatSpaces.ts` | telas cheias no chat, sidebar das Configurações e dos Espaços |
| `src-tauri/src/conversa/`, `src/features/chat/structured/` | conversa por protocolo (Codex pelo `app-server`, Claude Code pelo `claude -p` em stream-json) |
| `src/features/chat/DesignPane.tsx`, `DevicesPane.tsx`, `devicesModel.ts`, `devicesIpc.ts` | abas Design, Simulador iOS e Android do painel direito |
| `src/features/chat/chatModel.ts` | lógica pura: título da conversa, comando, projetos e cartões |
| `src/features/tabs/layout/layoutStore.ts` | `CHAT_GROUP`, `chatPlacements`, `placementsFrom({ chat })` |
| `src/app/shortcuts.ts` | `toggleChat` (Ctrl+Shift+L) |

## Próximas fases

O plano completo, com as fases F2 a F7, fica fora do repositório. Resumo:

| Fase | O quê |
|---|---|
| F2 | Conversas estruturadas (timeline com mensagens, ferramentas e diffs) num módulo Rust `conversa/`, começando pelo `codex app-server` |
| F3 | Aprovações e perguntas dentro do chat; modos Aceitar edições e Acesso total; Plano |
| F4–F6 | Claude e ACP; painel direito (diff, arquivos, navegador, dispositivos) e drawer de terminal; telas no visual novo |
| F7 | `ags chat`, MCP e skill |

## Vigia do chat (o orquestrador ciente dos integrantes)

Um time de conversas por protocolo não tem terminal para o Vigia das missões olhar. O **vigia do chat** (`chat_team/watch*.rs`, `ipc/commands/chat_watch.rs`) lê o que o backend já tem (pedidos `chat_request`, turnos `chat_run`, a timeline) e avisa o orquestrador, pela fila durável, quando um integrante: espera a **pessoa** há ≥ 20 s (comando, edição, pergunta), terminou o turno perguntando algo a ela, ou teve o turno falho; e quando a pessoa destrava. «Sem progresso» (15 min sem item novo) é um segundo interruptor, desligado por padrão. Os dois ficam no painel Time (`chat_team.watch`, `chat_team.watch_stall`). Sem LLM e sem cota; só avisa, e a decisão é sempre da pessoa. Detalhes: [`docs/agentes/VIGIA.md`](../agentes/VIGIA.md#no-chat-times-de-conversas-por-protocolo).

## Pool de contas na conversa

Com «pool:Nome» como conta e o interruptor ligado (Contas → Pools → «Pool de contas no chat»: desligado, avisar e perguntar ou automático), uma conversa por protocolo cujo turno falha por limite segue em outra conta do mesmo pool, com o resumo das últimas falas, e volta à original quando ela renova. Detalhes, tetos e a ressalva de política em [POOL_FAILOVER.md](./POOL_FAILOVER.md#pool-de-contas-no-chat-conversas-por-protocolo).
