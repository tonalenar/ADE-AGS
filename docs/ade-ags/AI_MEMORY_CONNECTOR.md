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
| `ai_memory_sessions` | `{cwd: string, workspace: string, project: string}` | `Session[]` |

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

A assinatura final é `ai_memory_sessions(cwd: String, workspace: String, project: String) -> Result<Untrusted<Vec<Session>>, String>`. O frontend obtém o par de `ai_memory_projects`, pré-seleciona pelo `project_name` que corresponde ao nome da pasta da aba e permite que a pessoa troque o projeto. O par deve ser preservado junto: nomes de projeto podem se repetir em workspaces diferentes. O backend recusa campos vazios, controles e valores acima de 512 bytes; não interpreta o par como argv nem tenta resolver por nome de pasta. A CLI usa sua configuração para conectar, sem porta fixa ou leitura de tokens pelo ADE. O `cwd` (a pasta da aba, como nas outras leituras) só localiza o binário e o servidor configurado; o escopo vem sempre do par `workspace`/`project`, sem selecionar outra rota por marker da aba. A pasta do processo do app não é usada (no Dock ela é `/`).

O protocolo interno envia `initialize`, aguarda a resposta, envia a notificação obrigatória `notifications/initialized` e faz **somente uma** `tools/call`, com nome constante `memory_briefing`, par explícito e `recent_pages_limit=0`. Nunca encaminha nome de tool ou parâmetros RPC do frontend e não usa `doctor`. Descarta regras/páginas e retorna só `recent_sessions`; valida o workspace/projeto devolvidos antes de aceitar o resultado. Cada sessão mantém `ended` e `handed_off`: `ended=false` também pode indicar um agente ainda trabalhando, não uma interrupção confirmada.

`util::spawn::with_stdio` abre o filho com stderr descartado, pipes e `kill_on_drop`, limita o diálogo por timeout e encerra/recolhe somente o PID que abriu, após resposta ou erro. O fake permanece aberto após responder, e os testes verificam que esse PID já não existe ao retornar. A fixture vazia de briefing é captura real da Fase 0; a fixture populada é uma derivação sintética explicitamente identificada. Nenhum teste executa o binário instalado, consulta a base real, chama modelo ou inicia serviço.

## Integração nas abas novas

O ajuste **Memória do ai-memory nas abas**, na seção de agentes, usa `ai_memory_tabs_enabled`. Ausência da chave significa ligado; `false` desliga a injeção. Erro ao ler o ajuste falha fechado. Só `terminal::pty_create` e, para as conversas por protocolo do Claude, `conversa::memoria` consultam a chave (ver «Conversas por protocolo do modo chat»): mudar o interruptor não reconfigura nem reinicia PTYs nem processos vivos. A variável `AI_MEMORY_RUN_AUTOWIRE=false` é imposta depois do ambiente do perfil em **todo** novo PTY, inclusive com o interruptor desligado, para impedir configuração global automática.

A descoberta usa o PATH do app e aceita apenas `--version` ≥3.3.0, sem consultar o servidor. Só o sucesso é cacheado, pelo caminho, tamanho e mtime do binário (uma troca do executável invalida o cache); uma falha passageira não desliga a integração até reiniciar o app. O mesmo cache serve às leituras do painel, que checam a versão uma vez só. A injeção automática reconhece somente `claude` e seus sufixos `.exe`/`.cmd`. Codex/OpenCode ficam sem MCP automático até existir escopo imposto por aba. Shells, wrappers com outro nome e Antigravity não recebem integração automática. Antigravity ficou fora por não haver mecanismo por aba verificado sem escrita global.

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

## Continuidade explícita em nova aba

O menu compartilhado das abas oferece **Continuar com outro agente**. Ele abre um diálogo de leitura antes de criar qualquer aba ou PTY. A origem permanece aberta. O diálogo consulta apenas `ai_memory_handoffs(cwd)` (`handoffs --json`); não aceita, cancela nem expira handoffs. Exibe origem, identificador e pasta como texto não confiável. A CLI 3.3.0 não devolve resumo nem corpo nesse endpoint, portanto o preview informa essa limitação. Codex e OpenCode aparecem desabilitados, com o motivo de escopo; somente Claude é destino nesta fase.

Após o clique em **Continuar com Claude**, o frontend cria uma nova aba na mesma pasta. Havendo candidatos para Claude (destinatário Claude ou aberto, cwd igual/ancestral por fronteira de caminho, ou cwd ausente), registra uma intenção efêmera, consumida uma única vez na criação do PTY. Não é persistida nem reaplicada em reinício ou reattach. Sem candidatos, ou com o ajuste de memória desligado, abre o agente normalmente, sem `run`. Falha na leitura impede confirmar; não transforma indisponibilidade do servidor em ausência de handoffs.

A intenção chega no argumento opcional `aiMemoryContinuity?: boolean` de `pty_create`. O backend exige binário compatível e hooks disponíveis, preserva o executável nativo e monta argv sem shell (exceto o prelaunch já existente):

```text
<ai-memory absoluto> run --no-autowire --no-exit-prompt --require-server --executable <claude absoluto> claude <args nativos> <settings/MCP da aba>
```

Na fonte v3.3.0, `commands/run.rs` condiciona o autowire a `!no_autowire`; esse modo não cria hooks/MCP adicionais. Por isso os argumentos nativos do ADE continuam depois do harness, uma única vez. `--require-server` impede degradação offline que pareceria continuidade bem-sucedida. O backend recusa o wrapper se não puder preparar seus hooks nem reconhecer um SessionStart do ai-memory no settings válido do perfil. Nenhum `--yolo`, `--fresh`, troca de modelo ou id de sessão é acrescentado. O prelaunch segue a mesma validação de citação existente; erro nesse caminho bloqueia somente a nova abertura.

O ADE nunca chama `accept`. Depois da confirmação, o SessionStart gerenciado pode aceitar automaticamente, de acordo com `claim_on_session_start` já configurado no servidor. O CAS do ai-memory garante claim-once. Não se altera essa opção global. Há corrida entre preview e abertura; a lista não reserva um id nem garante qual handoff será entregue. A CLI também não expõe `from_session_id`, necessário para diferenciar manuais (projeto inteiro) de automáticos (cwd); o filtro do preview é conservador e a escolha final permanece no servidor. A confirmação explicita a aceitação automática e a possibilidade de outro agente chegar antes.

Os arquivos temporários e sua limpeza seguem o mecanismo por aba acima. Não se muda key, pai ou montagem de Terminal e não se escreve nas configurações globais dos agentes. Os testes usam mocks de IPC e montagem de argv/settings em pasta temporária; não abrem agente real nem consultam a base instalada. UI visual e execução real de continuidade não verificadas.

Prova desta fase: `ags test affected` aprovado (86 testes Rust e 131 frontend relacionados, TypeScript e Babel); verificação adicional das abas/MCP com 168 testes aprovados; módulo `ai_memory::` com 39 testes; diálogo/lógica/catálogos com 11 testes. `cargo clippy --all-targets` concluiu: biblioteca com os mesmos 138 avisos herdados, nenhum aviso novo nas alterações; os targets de teste ainda contêm avisos herdados. Lint de testes: 40 violações antigas no baseline, nenhuma nova. Não houve HMR, instalação, agente real nem acesso à base instalada do ai-memory.

## Conversas por protocolo do modo chat

As conversas do modo chat que falam com o agente por protocolo (sem TUI) não passam por `pty_create`; abrem o processo em `conversa/*.rs`. A injeção por processo, a mesma das abas, existe só para o **Claude Code** (`claude -p` em stream-json), em `conversa::memoria`, chamada por `conversa::claude::spawn`:

- **O que entra:** `--settings <ADE-data>/mcp/tab-thread-<id>.ai-memory-<nonce>.settings.json` (hooks) e `--mcp-config <ADE-data>/mcp/tab-thread-<id>.json` (`mcpServers.ai-memory`, `mcp-bridge`). O nome vem de `thread-<id>` passado por `tab_config_name`, que só deixa letras, números, `-` e `_`. O ambiente do filho leva `AI_MEMORY_RUN_AUTOWIRE=false` sempre, também com o ajuste desligado ou o binário ausente.
- **Quando:** a cada abertura do processo. A primeira mensagem, a retomada (`--resume`) e a troca de modelo, esforço ou acesso (que fecham e reabrem o processo) preparam de novo; o servidor `ai-memory` que ficou no arquivo é retirado antes, então o ajuste desligado não deixa rastro. Nada muda num processo vivo.
- **O que respeita:** o ajuste `ai_memory_tabs_enabled` (padrão ligado), a versão mínima 3.3.0 (cache só de sucesso), um `--settings` já presente no comando (não é substituído) e o `SessionStart` do ai-memory que a pessoa já tenha nos próprios settings (os hooks dela não são duplicados; o MCP continua).
- **Limpeza:** o arquivo de hooks pertence ao `Session` do processo e some quando ele é solto; a varredura de configs do arranque (`sweep_configs_in`) remove o que sobrar de uma queda, e só poupa o `tab-thread-<id>.json` de uma conversa que ainda existe em `chat_thread`.
- **Falha:** nunca impede a conversa de abrir. Sem binário aceito, ou com o ajuste desligado, abre sem memória e sem aviso. Se o binário existe mas os arquivos não puderam ser gravados, abre sem memória e deixa um aviso (`memoryOff`) na timeline.
- **O que a tela mostra:** a coluna aditiva `chat_thread.memory` guarda `on` ou `off:<código>` (`disabled`, `unavailable`, `failed`, `nothing`, `unsupported`); o cartão **Conectores** do Resumo lê esse campo («ai-memory ligado» / «ai-memory fora: motivo»). Vazio = o processo ainda não abriu.

**Fora, e por quê:**

- **Codex, OpenCode e Antigravity por protocolo** não recebem nada e ficam gravados como `off:unsupported`. MCP: a 3.3.0 não impõe workspace/projeto no `mcp-bridge --no-session-id`, então o escopo cairia no projeto padrão do servidor (a mesma razão que retirou o MCP dessas TUIs). Hooks: nenhum dos três tem um flag de hooks por processo provado aqui; o `claude` aceita `--settings`, e o resto exigiria escrever em configuração global do agente, o que a integração proíbe. Não há suporte inventado: quando houver flag por processo verificado, entra em `conversa::memoria` com o teste correspondente.
- **Agentes de um time** abertos por protocolo seguem a mesma regra do próprio agente (só o Claude).
- **Windows e agente real** não foram exercitados nesta fase; os testes usam arquivos temporários e um binário só como caminho.

Prova: `conversa/test_memoria.rs` (hooks e MCP, ambiente, remoção do arquivo, reabertura sem duplicar, `--settings` explícito, hooks do usuário, ajuste desligado, binário ausente, falha de gravação, varredura) e um teste `#[ignore]` com o roteiro de ponta a ponta.

## Intermediário MCP de projeto fixo (substitui a mitigação dos bridges estáticos)

Novas abas Codex/OpenCode podem receber `ags ai-memory-bridge --cwd <pasta> --workspace <W> --project <P>`.
O ADE consulta `list-projects --json` no cwd da aba e usa o equivalente conservador de guessProject:
exatamente um projeto cujo nome corresponde ao último componente da pasta, sem diferenciar maiúsculas.
Nenhum match, homônimos entre workspaces, erro de CLI, versão antiga ou ausência do CLI `ags` ao lado
do app omitem a injeção. Isso é uma escolha por nome, não uma prova de associação por marker; o par
selecionado fica fixo durante a vida do processo. Não usa o projeto padrão do servidor.

O intermediário abre apenas `ai-memory mcp-bridge --no-session-id`, no cwd explícito, com
`AI_MEMORY_HOST_CWD` explícito, `AI_MEMORY_RUN_AUTOWIRE=false` e embeddings desabilitados no filho.
Nenhum token/config do ai-memory é lido pelo ADE. Codex recebe `-c mcp_servers.ai-memory.command/args`;
OpenCode recebe `OPENCODE_CONFIG_CONTENT` mesclado, preservando `mcp.ags`. Claude mantém o caminho com sessão.
Nenhuma aba viva ou configuração global é alterada.

Lista fechada auditada na tag v3.3.0, commit `4d4d9ca389145bf16dcb56122626162833335ec8`,
`crates/ai-memory-mcp/src/server.rs`: QueryArgs:650, RecentArgs:799, StatusArgs:815,
ReadPageArgs:1716, PatchPageArgs:1761 e WritePageArgs:1936. Somente `memory_query`, `memory_recent`,
`memory_status`, `memory_read_page`, `memory_write_page` e `memory_patch_page` são expostas.
Todas recebem workspace/project fixos em cada tools/call. Valor ausente/null é preenchido;
valor divergente é **recusado**, não sobrescrito. `global=true`, `scope` diferente de project/null,
`scopes` não vazio e projetos reservados `_global`, `_profile` e `_profile.*` são recusados (também após trim e normalização de caixa). `scope:project` é normalizado
para a forma padrão da CLI. Outras tools (incluindo operações por ID, mensagens, handoffs,
consolidação e manutenção) são recusadas e ocultadas de tools/list. Não há heurística de nome/schema.
Os metadados/conteúdo globais que o próprio ai-memory une implicitamente em suas leituras normais
continuam sendo comportamento do servidor; o intermediário bloqueia a seleção explícita de outro escopo.

Somente initialize, notifications/initialized, ping, tools/list e tools/call são encaminhados.
Requests do servidor ao cliente não são repassados. JSON-RPC usa linhas limitadas a 2 MiB,
preserva fragmentos entre seleções concorrentes de I/O e encerra/recolhe apenas o PID filho aberto,
em EOF/erro de qualquer lado. Prazo máximo da conexão: 24 horas. Sem prompt do modelo como barreira
para escopo. O comando é local, antes do despacho IPC normal; help e skill documentam a exceção stdio.

Testes: bridge fake stdio, carimbo das seis tools, escopo divergente/global/perfil/múltiplos,
filtragem da listagem, PID recolhido, fragmentos cancelados pelo select, resolução ambígua/ausente
e preservação do MCP ags nas configurações. Sem agente real ou acesso à base real do ai-memory.

Validação do intermediário: `ags test affected` aprovado (115 testes frontend, TypeScript/Babel,
1887 testes da biblioteca e 46 do binário ags, além de 2 sondas isoladas de teste). A seleção Rust
ampla foi decidida pelo runner afetado pela mudança na CLI; 16 testes herdados foram ignorados.
Após o bloqueio adicional dos projetos reservados, `cargo test --lib ai_memory::` aprovou 52 testes;
a última execução específica do intermediário aprovou os 6 testes, incluindo recusas pelo transporte
fake sem encaminhá-las ao filho. Clippy all-targets concluiu sem avisos nos arquivos novos
(138 avisos herdados da lib); lint mantém 40 violações antigas, nenhuma nova. Catálogos/diálogo:
8 testes aprovados. Nenhum cliente real foi executado; Windows não foi validado.

### Prioridade do marcador nos worktrees

Antes de guessProject, a resolução estática procura `.ai-memory.toml` a partir do cwd da nova aba.
Dentro de `$HOME`, consulta até o próprio home; fora dele, até a raiz do checkout mais próxima
(`.git` arquivo ou diretório). Fora de home e sem checkout, consulta somente cwd. Sem home definido,
consulta até a raiz do filesystem. Caminhos existentes são canonicalizados para respeitar fronteiras
com symlinks. Arquivos maiores que 2 MiB, ilegíveis, TOML inválido ou pares com tipos/valores inválidos
são ignorados; marcadores somente `[capture]` são transparentes. O marcador mais próximo com settings
reconhecidos governa a busca: um marcador parcial não herda a metade ausente de um ancestral.

Um par explícito válido workspace/project vence o basename e é aceito mesmo sem existir em
`list-projects`: o marcador é a declaração do repositório para clientes estáticos, e
`memory_write_page` v3.3.0 cria projetos nomeados na primeira escrita autorizada. O ADE não cria projeto
na resolução. As tools de leitura podem responder “não encontrado” até existir conteúdo. Projetos
reservados continuam recusados. Sem par utilizável, permanece o fallback de correspondência única
por basename em `list-projects --json`; sem match ou com ambiguidade, não injeta.

Fonte: `docs/marker-file.md` (“Where to put it”, “Static MCP clients”, “What the marker file does NOT do”)
e `crates/ai-memory-mcp/src/server.rs::WritePageArgs`, tag v3.3.0. TOML usa o `toml_edit` já resolvido no
lockfile, agora declarado diretamente; nenhuma versão transitiva foi atualizada. A resolução não
lê arquivos de instalação, tokens ou config do ai-memory: somente o marcador do repositório.

Prova do ajuste: 57 testes `ai_memory::` aprovados, incluindo 5 testes de marcador em temporários.
O caso de marcador inválido na fronteira foi observado falhando antes da correção do iterador e
passou depois; nunca se sobe acima do home/checkout, mesmo quando o arquivo da fronteira é inválido.
Clippy all-targets sem avisos nas alterações, com os 138 avisos herdados da lib; lint de testes sem
violação nova. `ags test affected --dry-run` selecionou a suíte Rust inteira por causa do manifesto;
não a repetimos nesta mudança sem schema/IPC, conforme a política de testes: executamos o módulo e
compilamos todos os targets com Clippy. Sem binário/base real do ai-memory nos testes.
