# Conector de leitura do ai-memory

O conector opcional executa somente a CLI externa `ai-memory`, versão mínima **3.3.0**. Não instala o binário, inicia servidor, captura sessões, registra hooks/MCP, aceita bastões ou importa memória. O frontend deve chamá-lo somente após o opt-in do usuário. O armazenamento externo permanece separado da memória aprovada do ADE.

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

A pasta absoluta existente vem da aba selecionada. O processo recebe essa pasta em `current_dir` e `AI_MEMORY_HOST_CWD`; o override herdado `AI_MEMORY_SCOPE_CWD` é removido. Não há `--cwd` nessa release. O resolvedor nativo (`ai-memory-cli/src/commands/mod.rs::resolve_scope`) aplica markers `.ai-memory.toml`, rotas de home, identidade do remoto git e fallback pelo basename. O ADE deixa a CLI resolver, em vez de reimplementar parcialmente ou ler seus arquivos de configuração. Não confundir esse workspace com o id de workspace do ADE. `status` e `list-projects` são consultas globais do servidor selecionado pela CLI; não representam filtros por projeto.

DTOs TypeScript correspondentes aos structs de `src-tauri/src/ai_memory/types.rs` (nenhum tipo é gerado automaticamente):

```ts
interface Untrusted<T> { source: 'ai-memory'; trust: 'UNTRUSTED'; data: T }
interface Probe {
  state: 'missing' | 'outdated' | 'server_down' | 'ok';
  version: string | null;
  installation_instruction: string | null;
  status: Status | null;
  sessions_supported: false;
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
- Sessões recentes ficam **fora desta fase**, com `sessions_supported=false`. Não se inicia `mcp-bridge` nem se expõe uma ponte genérica: o servidor externo tem tools mutadoras. Uma implementação posterior deve permitir exclusivamente `memory_briefing`.

## Prova

Fixtures reais normalizadas em `src-tauri/src/ai_memory/fixtures/`, com proveniência e checksum do pacote na pasta. Testes de parse são multiplataforma; os testes de subprocesso usam scripts fake em diretório temporário no Unix. Não chamam o ai-memory instalado, rede, modelo ou dados reais. Timeout usa prazo zero, sem espera real no teste. Windows e uso manual da UI não verificados nesta entrega. Desempenho de produto não medido.

Verificado nesta entrega: `cargo test --lib ai_memory::` — 6 testes aprovados; `cargo clippy --lib` — sucesso, sem avisos em `src/ai_memory/` (o crate tem avisos herdados fora da mudança); `node scripts/test-lint.mjs` — nenhuma violação nova. O caso de metadados SemVer `3.3.0+local-build` foi reproduzido falhando antes de corrigir o comparador.

## Por que o bridge de sessões ainda não está exposto

Na tag `v3.3.0`, `mcp-bridge --no-session-id` encaminha JSON-RPC ao servidor sem uma identidade de sessão e **sem transmitir o cwd** (`ai-memory-cli/src/commands/mcp_bridge.rs`, `upstream_config`). `memory_briefing` recebe `workspace` e `project` em `BriefingArgs`, mas não `cwd` (`ai-memory-mcp/src/server.rs:1647`). O teste upstream de roteamento nessa mesma fonte (`static client falls back to the server default and says so`, perto da linha 17514) demonstra que a consulta estática sem par explícito usa o projeto padrão do servidor. Isso não equivale à pasta da aba, mesmo com `current_dir` correto no processo do bridge.

Por isso não se adicionou `ai_memory_sessions(cwd)` com parâmetros de escopo inferidos: poderia exibir sessões de outro projeto. A CLI de leitura não oferece um comando dedicado para exportar o resultado de `resolve_scope`. `doctor --json` inclui o par, porém também percorre sessões/configurações de vários agentes e não foi introduzido como dependência indireta de uma listagem de sessões. Extrair o escopo de uma página também não resolve projetos vazios nem sessões interrompidas que ainda não geraram página.

Um seguimento pode receber `workspace` e `project` explicitamente escolhidos pelo usuário dentre `ai_memory_projects`, além do cwd, ou usar um futuro resolvedor nativo de escopo. Só então deve abrir o bridge temporário, enviar `initialize` e a chamada de nome fixo `memory_briefing`, extrair `recent_sessions` e encerrar o processo próprio. Não deve disponibilizar `tools/call` genérico nem encaminhar nomes de tools recebidos do frontend. Até essa decisão, `sessions_supported=false` permanece o contrato honesto.
