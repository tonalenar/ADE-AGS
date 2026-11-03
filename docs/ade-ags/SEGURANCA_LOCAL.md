# Segurança local: editor, loopback, ambiente e aprovações

Quatro proteções que vieram da análise do `deepseek-ai/deepseek-harness` (pontos 9, 10, 18 e 20). Cada uma fecha um jeito de a ADE fazer algo que a pessoa não pediu.

## 1. O editor não pisa a edição de um agente (ponto 9)

Ao abrir um arquivo, a aba guarda um **token de versão** opaco: `tamanho:mtime_ns:inode` (no Windows, sem o inode). Ao salvar, o backend (`explorer/files.rs`, `explorer_write_file`) só grava se o arquivo ainda tem esse token. Antes era só o `mtime` em milissegundos, que não percebia:

- disco com resolução grossa ou um agente que restaura o mtime (`cp -p`, `touch -r`) depois de mudar o arquivo;
- um arquivo apagado com a aba aberta: salvar recriava em silêncio.

O `expectedVersion` do salvar:

| Valor | Quando | O que faz |
|---|---|---|
| o token lido | salvar comum | grava se o token bate; senão, conflito (aviso "recarregar ou substituir") |
| `absent` | o arquivo sumiu do disco (aviso "não existe mais") | cria com `create_new`: se alguém recriou o nome no meio-tempo, é conflito |
| `null` | a pessoa escolheu "Substituir", ou "salvar como" (exportar prancheta) | grava sem conferir |

Um conflito com `version: null` quer dizer "sumiu"; com versão, "mudou". A decisão do front está em `src/features/editor/fileVersion.ts`. A conferência e a troca pelo `rename` não são atômicas juntas: sobra uma janela de microssegundos entre ler o token e gravar.

## 2. Só a aba da app fala com o proxy do navegador (ponto 10)

O proxy do `preview/` reenvia com a sessão guardada do projeto e escuta numa porta previsível. A regra fica em `util/loopback_trust.rs`, para servir a qualquer servidor HTTP de loopback (inclusive um MCP HTTP futuro):

- **`Host`** precisa ser `localhost`, `127.0.0.1` ou `[::1]` com a porta do servidor. Com DNS rebinding, o `Host` é o domínio do atacante.
- **`Origin`**, quando vem, precisa ser deste servidor. `null` (iframe com sandbox) passa em pedido comum, nunca num WebSocket.
- **`Sec-Fetch-Site: cross-site`** só passa numa navegação `GET`/`HEAD` (`Sec-Fetch-Mode: navigate`). É assim que o iframe da app (`tauri://localhost`, outro site) abre a página. O que isso fecha: `<img src>` ou `<script src>` de outro site não mandam `Origin` e antes chegavam ao dev server com a sessão do projeto.
- `same-origin`, `same-site` (outra porta do loopback), `none` ou cabeçalho ausente passam. Curl e WebKits antigos não mandam `Sec-Fetch-*`; contra eles valem o `Host` e o `Origin`.

O recusado recebe `403`; o log (`[preview] pedido recusado (<motivo>)`) leva só o motivo e o caminho, nunca a query. O HMR do Vite pelo proxy segue funcionando: o teste `el_websocket_del_recargado_en_caliente_atraviesa_el_proxy` manda o handshake como o navegador manda (`Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: websocket`).

Fora do escopo: as pranchetas de design não têm servidor (são `srcdoc`); os portais usam este mesmo proxy. O callback OAuth do Antigravity (`accounts/antigravity_oauth.rs`) recebe uma navegação cross-site do Google por definição e é protegido pelo `state`; não foi mexido. O servidor IPC da CLI não é HTTP e exige token.

## 3. Segredos fora do ambiente dos agentes, por padrão (ponto 18)

`runs/sandbox.rs` trocou a lista fixa `SCRUBBED_ENV` por uma regra: sai do ambiente herdado toda variável cujo nome tenha um pedaço (entre `_`, `-`, `.`, `/`, `:`) igual a `KEY`, `TOKEN`, `SECRET`, `PASSWORD` ou `PASSWD`, ou essas palavras coladas a `API`, `ACCESS`, `AUTH`, `PRIVATE`, `CLIENT`, `SERVICE`, `BOT`, `REFRESH`, `BEARER`, `DB` (`APIKEY`, `_authToken`). `SSH_AUTH_SOCK` e `DOCKER_AUTH_CONFIG` saem também. `MONKEY_PATCH`, `KEYBOARD_LAYOUT` e `TOKENIZERS_PARALLELISM` não caem.

Ficam as do provider (`PROVIDER_ENV`): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, as da AWS para o Bedrock, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `JETSKI_OAUTH_TOKEN`, `CURSOR_API_KEY` e as dos providers que o OpenCode aceita. A ordem é sempre:

1. o ambiente herdado, menos as credenciais;
2. a conta da tarefa (`apply_account_env`: o perfil isolado do pool por `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_DATA_HOME`, que não são segredo, e a retirada de uma API key que ganharia do login);
3. as `AGS_*`/`ADE_*` da app. Uma `AGS_*`/`ADE_*` herdada com cara de segredo sai; a que a app já pôs no comando fica.

Onde vale:

| Processo | Filtro |
|---|---|
| Frota headless e `oneshot` (`runs/supervisor.rs`, `runs/oneshot.rs`) | sempre que o sandbox não está `off` |
| MCP do ai-memory lançado pela ADE (`ai_memory/client.rs`, `ai_memory/scoped_bridge.rs`) | sempre |
| Aba de integrante de missão com `scrubSecrets` (`pty_create`) | quando a aba pede |
| Aba comum da pessoa | nunca: fica como estava |

O `ags mcp` que as TUIs lançam herda o ambiente do agente: na frota já vem filtrado; numa aba comum, não.

**Pendente:** o sinal por integrante existe de ponta a ponta (`TeamMember.scrubSecrets` → `addTab` → `Tab.scrubSecrets` → `pty_create`), mas ainda não há onde a pessoa o escolha nem onde guardá-lo: falta uma coluna aditiva em `squad_members` e o interruptor no editor de Squad. O campo da aba não é persistido, então reabrir o app relança a aba sem o filtro.

## 4. Auditoria de aprovação com um vocabulário só (ponto 20)

A frota (`task_approvals`) e o chat (`chat_request`) continuam com as próprias tabelas. Por cima, a tabela nova e aditiva `approval_events` (`approval_audit.rs`) guarda um **par** por pedido:

- `asked`: id próprio, origem (`fleet`/`chat`), `call_id` (o id do pedido na tabela de origem), dono (tarefa ou conversa) e o **nome** da ferramenta. Os argumentos não são copiados.
- `decided`: id próprio, `asked_id` apontando para o `asked`, o mesmo `call_id`, `decided_by` e o **resultado fechado**:

| Resultado | Libera | Frota | Chat |
|---|---|---|---|
| `allowed-once` | **sim** (o único) | pessoa ou regra liberou | `allow`, ou `allowSession` (com `scope = session`) |
| `rejected` | não | pessoa, regra ou política do papel negou | `deny`/`decline`, ou qualquer escolha desconhecida |
| `cancelled` | não | tarefa cancelada, app fechado com o pedido aberto | `cancel`, o motor desistiu (`resolved`), o turno acabou (`expired`), app fechado |
| `unavailable` | não | ninguém respondeu no prazo | — |

O índice único `(source, call_id, phase)` faz a **primeira** decisão valer, como o agente, que só lê a primeira resposta. Na frota o resultado sai do `Verdict` (`Verdict::outcome`): só `allow = true` vira `allowed-once`, então o registro nunca diz "liberado" de algo que o agente recebeu negado. Perguntas do chat não são aprovações e não entram. Gravar é best-effort: uma falha do registro não muda a resposta ao agente.

Ainda não há tela nem comando que leia `approval_events`; os dados estão lá para a consola de aprovações e o `ags` usarem.
