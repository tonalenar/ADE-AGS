# Conector de leitura do ai-memory

O conector executa somente a CLI externa `ai-memory`, versão mínima **3.3.0**. Não instala o binário, inicia servidor HTTP, captura sessões, registra hooks/MCP, aceita bastões ou importa memória. O ai-memory é a memória de longo prazo do ADE ([decisão](../decisoes/AI_MEMORY.md)); o SQLite de memória antigo fica só leitura, como fonte da migração. O painel aparece em Ajustes → Memória (`src/features/memory/AiMemoryPanel.tsx`).

## Comandos Tauri

Todas as funções são assíncronas e retornam `Result<Untrusted<T>, String>`. Os erros são mensagens em PT-BR; stderr do processo externo não atravessa a fronteira, pois pode conter credenciais.

| Comando | Argumentos do invoke | `T` |
|---|---|---|
| `ai_memory_probe` | `{cwd: string}` | `Probe` |
| `ai_memory_status` | `{cwd: string}` | `Status` |
| `ai_memory_handoffs` | `{cwd: string}` | `Handoff[]` |
| `ai_memory_recent` | `{cwd: string}` | `RecentPage[]` |
| `ai_memory_search` | `{cwd: string, query: string}` | `SearchHit[]` |
| `ai_memory_read_page` | `{cwd: string, path: string}` | `Page` |
| `ai_memory_projects` | `{cwd: string}` | `Project[]` |
| `ai_memory_sessions` | `{workspace: string, project: string}` | `Session[]` |

A pasta absoluta existente vem da aba selecionada. O processo recebe essa pasta em `current_dir` e `AI_MEMORY_HOST_CWD`; o override herdado `AI_MEMORY_SCOPE_CWD` é removido. Não há `--cwd` nessa release. O resolvedor nativo (`ai-memory-cli/src/commands/mod.rs::resolve_scope`) aplica markers `.ai-memory.toml`, rotas de home, identidade do remoto git e fallback pelo basename. O ADE deixa a CLI resolver, em vez de reimplementar parcialmente ou ler seus arquivos de configuração. Não confundir esse workspace com o id de workspace do ADE. `status` e `list-projects` são consultas globais do servidor selecionado pela CLI; não representam filtros por projeto.

DTOs TypeScript correspondentes aos structs de `src-tauri/src/ai_memory/types.rs` (nenhum tipo é gerado automaticamente):

```ts
interface Untrusted<T> { source: 'ai-memory'; trust: 'UNTRUSTED'; data: T }
interface Probe {
  state: 'missing' | 'outdated' | 'server_down' | 'ok';
  version: string | null;
  installation_instruction: string | null;
  status: Status | null;
  sessions_supported: true;
}
interface Counts { pages_latest: number; pages_all: number; sessions: number; observations: number }
interface Provider { status: string; provider: string | null; model: string | null; dim: number | null }
interface Status {
  version: string;
  counts: Counts;
  client: { version: string } | null;
  providers: { embedding: Provider | null; llm: Provider | null } | null;
  capture_mode: string | null;
}
interface Handoff {
  id: string; from_agent: string; to_agent: string | null;
  cwd: string | null; created_at_ms: number;
}
interface SearchHit {
  path: string; title: string; snippet: string; rank: number;
  workspace: string | null; project: string | null;
}
interface RecentPage {
  path: string; title: string; snippet: string; updated_at: string;
  workspace: string | null; project: string | null;
}
interface Page {
  path: string; workspace: string; project: string; title: string | null;
  body: string; frontmatter: unknown; expired: boolean;
}
interface Session {
  session_id: string; agent_kind: string; cwd: string | null;
  last_activity_at: string; ended: boolean; handed_off: boolean; current: boolean;
}
interface Project {
  workspace_id: string | null; workspace_name: string;
  project_id: string | null; project_name: string;
  page_count: number; last_updated: string | null;
}
```

Campos desconhecidos da CLI são ignorados e opcionais ausentes viram `null` (ou defaults documentados para página). `handoffs` só retorna metadados: a CLI não inclui resumo nem próximos passos. `recent` lista **páginas**, não sessões. `snippet` mantém `<mark>` recebido como dado; o frontend deve exibir texto sem interpretar HTML. `frontmatter` e todo corpo externo continuam não confiáveis. O status é um DTO reduzido: não repassa paths internos, URLs, auth ou mensagens de erro de provedores.

## Limites e efeitos

- A descoberta usa `util::path_env::find_program`, o resolvedor por trás de `program`; executa somente o caminho encontrado. Ausência não pode cair em um executável homônimo no cwd do Windows.
- `util::external_path` trata caminhos externos e `util::launch::external_command` evita montar comandos de shell; `util::spawn::output` limita cada processo a 10 segundos e encerra seu grupo no timeout. São até dois processos por chamada (versão e leitura), fora da thread da UI.
- `AI_MEMORY_RUN_AUTOWIRE=false` em todas as chamadas; `AI_MEMORY_EMBEDDING_PROVIDER=none` evita inicialização local de embeddings pelo cliente. O ADE nunca lê token, banco, wiki ou configuração do ai-memory. O binário externo pode registrar logs próprios conforme sua configuração; “leitura” descreve as operações disponibilizadas pelo ADE.
- Lista fechada de operações, até 50 resultados por lista/busca, consulta até 4096 bytes e caminho relativo até 1024 bytes. O terminador `--` separa a busca das flags. Não existe endpoint genérico que aceite argv arbitrário.
- Respostas acima de 2 MiB são recusadas **depois** da coleta pelo helper existente; esse limite não é um teto de memória durante a leitura dos pipes.
- Versões anteriores a 3.3.0 (inclusive pré-release de 3.3.0) não fazem leituras. Falha do subprocesso/status gera `server_down`; JSON incompatível nas leituras gera erro. A instrução de instalação é só texto com a release oficial e orientação de checksum.
- Sessões recentes usam apenas `mcp-bridge --no-session-id` temporário e a tool fixa `memory_briefing`. Não se expõe ponte genérica. `sessions_supported=true` indica suporte implementado; o servidor ainda precisa estar disponível. O prazo do diálogo é 10 segundos, mais até 2 segundos para recolher o filho. O leitor limita cada mensagem a 2 MiB durante a leitura e tolera até 16 notificações por resposta.

## Prova

Fixtures reais normalizadas em `src-tauri/src/ai_memory/fixtures/`, com proveniência e checksum do pacote na pasta. Testes de parse são multiplataforma; os testes de subprocesso usam scripts fake em diretório temporário no Unix. Não chamam o ai-memory instalado, rede, modelo ou dados reais. Timeout usa prazo zero, sem espera real no teste. Windows e uso manual da UI não verificados nesta entrega. Desempenho de produto não medido.

Verificado nesta entrega: `cargo test --lib ai_memory::` — 10 testes aprovados; `cargo clippy --lib` — sucesso, sem avisos em `src/ai_memory/` (o crate tem avisos herdados fora da mudança); `node scripts/test-lint.mjs` — nenhuma violação nova. O caso de metadados SemVer `3.3.0+local-build` foi reproduzido falhando antes de corrigir o comparador.

## Sessões por escopo explícito

Na tag `v3.3.0`, `mcp-bridge --no-session-id` encaminha JSON-RPC ao servidor sem uma identidade de sessão e **sem transmitir o cwd** (`ai-memory-cli/src/commands/mcp_bridge.rs`, `upstream_config`). `memory_briefing` recebe `workspace` e `project` em `BriefingArgs`, mas não `cwd` (`ai-memory-mcp/src/server.rs:1647`). O teste upstream de roteamento nessa mesma fonte (`static client falls back to the server default and says so`, perto da linha 17514) demonstra que a consulta estática sem par explícito usa o projeto padrão do servidor. Isso não equivale à pasta da aba, mesmo com `current_dir` correto no processo do bridge.

A assinatura final é `ai_memory_sessions(workspace: String, project: String) -> Result<Untrusted<Vec<Session>>, String>`. O frontend obtém o par de `ai_memory_projects`, pré-seleciona pelo `project_name` que corresponde ao nome da pasta da aba e permite que a pessoa troque o projeto. O par deve ser preservado junto: nomes de projeto podem se repetir em workspaces diferentes. O backend recusa campos vazios, controles e valores acima de 512 bytes; não interpreta o par como argv nem tenta resolver por nome de pasta. A CLI usa sua configuração para conectar, sem porta fixa ou leitura de tokens pelo ADE. Esse endpoint não recebe cwd; usa o servidor configurado no contexto do aplicativo, sem selecionar outra rota por marker da aba.

O protocolo interno envia `initialize`, aguarda a resposta, envia a notificação obrigatória `notifications/initialized` e faz **somente uma** `tools/call`, com nome constante `memory_briefing`, par explícito e `recent_pages_limit=0`. Nunca encaminha nome de tool ou parâmetros RPC do frontend e não usa `doctor`. Descarta regras/páginas e retorna só `recent_sessions`; valida o workspace/projeto devolvidos antes de aceitar o resultado. Cada sessão mantém `ended` e `handed_off`: `ended=false` também pode indicar um agente ainda trabalhando, não uma interrupção confirmada.

`util::spawn::with_stdio` abre o filho com stderr descartado, pipes e `kill_on_drop`, limita o diálogo por timeout e encerra/recolhe somente o PID que abriu, após resposta ou erro. O fake permanece aberto após responder, e os testes verificam que esse PID já não existe ao retornar. A fixture vazia de briefing é captura real da Fase 0; a fixture populada é uma derivação sintética explicitamente identificada. Nenhum teste executa o binário instalado, consulta a base real, chama modelo ou inicia serviço.

## Integração nas abas novas

O ajuste **Memória do ai-memory nas abas**, na seção de agentes, usa `ai_memory_tabs_enabled`. Ausência da chave significa ligado; `false` desliga a injeção. Erro ao ler o ajuste falha fechado. Só `terminal::pty_create` consulta a chave: mudar o interruptor não reconfigura nem reinicia PTYs vivos. A variável `AI_MEMORY_RUN_AUTOWIRE=false` é imposta depois do ambiente do perfil em **todo** novo PTY, inclusive com o interruptor desligado, para impedir configuração global automática.

A descoberta usa o PATH do app e aceita apenas `--version` ≥3.3.0, sem consultar o servidor. O resultado é cacheado pelo caminho, tamanho e mtime do binário; uma troca do executável invalida o cache. A injeção automática reconhece somente `claude` e seus sufixos `.exe`/`.cmd`. Codex/OpenCode ficam sem MCP automático até existir escopo imposto por aba. Shells, wrappers com outro nome e Antigravity não recebem integração automática. Antigravity ficou fora por não haver mecanismo por aba verificado sem escrita global.

| Agente | Injeção no nascimento do PTY |
|---|---|
| Claude | Soma `mcpServers.ai-memory` ao `tab-<id>.json` do ADE, preservando `ags`; comando absoluto do binário e `args: ["mcp-bridge"]`. Claude fornece `CLAUDE_CODE_SESSION_ID` ao iniciar esse MCP. Se não existir o config do ADE, cria somente o registro adicional e acrescenta `--mcp-config`. |
| Claude (captura) | `--settings <ADE-data>/mcp/tab-<id>.ai-memory-<nonce>.settings.json`. JSON `{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"'<binário>' hook --event session-start --agent claude-code"}]}], ...}}`. Windows usa exec form: `command` é o binário, `args` é o vetor nativo. Sem token ou URL no arquivo. |
| OpenCode | MCP automático do ai-memory desativado: o bridge estático não fixa o escopo da pasta. O MCP `ags`, permissões e conteúdo configurado pela pessoa permanecem intactos. |
| Codex | MCP automático do ai-memory desativado pelo mesmo limite de escopo. Sem hooks ou novos `-c mcp_servers.ai-memory.*`; configurações globais da pessoa não são removidas. |

Os hooks nativos foram conferidos na tag v3.3.0: `cli.rs::HookArgs`, `commands/render_shared.rs::CLAUDE_CODE_EVENTS` e `HookCommandPlatform::for_bash_runner`. macOS/Linux usam `PosixNative` por padrão e Windows usa `WindowsNative`. Existe o subcomando `hook`, portanto **não é necessário instalar os scripts `.sh`** para esta injeção. Eventos: SessionStart/session-start, UserPromptSubmit/user-prompt-submit, PreToolUse/pre-tool-use, PostToolUse/post-tool-use, PreCompact/pre-compact, Stop/stop, SessionEnd/session-end, SubagentStart/subagent-start e SubagentStop/subagent-stop. SessionEnd recebe timeout de 15s, como o instalador nativo. Não se habilita captura de resposta do assistente por flags adicionais.

Antes de criar o arquivo de hooks, o ADE lê somente `~/.claude/settings.json` e `settings.json` sob o `CLAUDE_CONFIG_DIR` efetivo do perfil. Se qualquer um já contém hook do ai-memory, não injeta outro. Arquivo inválido/ilegível também suprime a captura; MCP continua independente. Um `--settings` explícito no comando da pessoa é preservado e suprime o arquivo adicional. Nenhum desses arquivos do usuário é escrito. Configuração de projeto do Claude não é inspecionada por esta verificação.

O arquivo de hooks tem nonce por instância, para o encerramento de uma instância anterior não apagar o arquivo de uma nova. É removido no término do PTY ou na falha antes do spawn; o barrido de MCP reconhece o sufixo e remove órfãos, preservando abas registradas. O MCP base continua com o ciclo de limpeza já usado pelo ADE. Ao criar novo PTY, um registro antigo de ai-memory no config MCP **do ADE** é retirado antes de aplicar a decisão atual, inclusive no opt-out. Nada é removido de config global do agente.

Sem prelaunch, os argumentos são anexados diretamente ao `CommandBuilder`, sem remontar/parsing de strings. Com prelaunch POSIX, recebem citação de shell. Com prelaunch Windows, valores que exigiriam escape inseguro (`"`, `%`, `!`, `^`, quebras de linha) fazem a integração ser omitida e a aba abrir normalmente; não se tenta reinterpretar esses caracteres. Windows e captura real não foram executados nesta entrega. Provas usam fakes e montagem de arquivos em diretório temporário, sem acessar a instalação/base real.

Comandos Claude que já contêm o terminador literal `--` não recebem flags adicionais, pois elas virariam texto do prompt. Configurações e wrappers especiais continuam sendo decisão da pessoa, sem reescrita silenciosa do comando.

O opt-out não desliga hooks/MCP que a pessoa já instalou globalmente por conta própria; apenas impede acréscimos do ADE. Verificação desta fase: 15 testes `ai_memory::`, 23 testes `terminal::test::`, 12 testes `tabMcp.test.ts`, TypeScript, Babel e lint de testes aprovados. Clippy não adicionou avisos em relação à base. Não houve teste de captura com agente real, HMR, instalação ou execução contra a base real do ai-memory.

### Mitigação dos bridges estáticos

A 3.3.0 não impõe workspace/projeto em `mcp-bridge --no-session-id`. A query de URL não seleciona escopo e o relay repassa `tools/call` sem completar argumentos. Por isso foi retirada a injeção automática de MCP do ai-memory em Codex/OpenCode. O Claude continua session-aware, o painel usa chamadas de nome fixo com par explícito e `AI_MEMORY_RUN_AUTOWIRE=false` continua em todo novo PTY. Um adapter por aba depende de decisão posterior; instruções no prompt não substituem imposição de escopo. Abas vivas e configurações globais preexistentes não são alteradas.

Prova da mitigação: teste de regressão inicialmente falhou porque OpenCode ainda recebia `OPENCODE_CONFIG_CONTENT` adicional; após retirar os bridges estáticos, `cargo test --lib ai_memory::` passou com 31 testes na base integrada. TypeScript, Babel e lint de testes passaram; Clippy voltou aos 138 avisos herdados, sem aviso novo no conector.
