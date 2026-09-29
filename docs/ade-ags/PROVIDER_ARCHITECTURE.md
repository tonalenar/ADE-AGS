# Provider architecture

Proposta para evoluir o registry atual até algo no formato `AgentProvider` / `AgentAdapter`, sem reescrever a app. Nada disto está implementado nesta etapa.

## O que já é um provider, sem esse nome

`AgentDef` em `src-tauri/src/agents/registry.rs` já é uma linha declarativa. O frontend não tem uma segunda tabela. Contas, skills, resume e o estilo de MCP saem dessa linha. A frota escolhe o adapter em `runs/agents.rs` com um `match` no `id`.

O que está espalhado, e é o problema real:

| Capacidade | Onde vive hoje | Por que não cabe num campo a mais |
|---|---|---|
| Detectar binário e versão | `agents/detector.rs` | I/O, timeout, regra especial do shell |
| Layout do home da conta | `match` em `accounts/profiles.rs` (`default_dir`, `system_marker_root`) | Claude guarda `.claude.json` no home, não dentro de `~/.claude`. OpenCode aninha `opencode/` debaixo do `XDG_DATA_HOME`. Gemini aninha `.gemini/` debaixo do `GEMINI_CLI_HOME` |
| Achar e titular a sessão | `match` de `SessionSource` em `session/title.rs` | Cada CLI tem um formato. Gemini e Kimi ainda ignoram o diretório da conta |
| Lançar headless e parsear eventos | trait `HeadlessAgent` + `match` em `adapter_for` | Argv e dialeto JSON são código |
| Injetar o MCP da app | `McpStyle` + `ipc/mcp.rs` | Só dois estilos existem |
| Listar modelos | `ModelSource` | Claude é lista fixa, OpenCode é subprocesso, o resto é `Unknown` |
| Uso e custo | `usage/` (Claude) e o que cada adapter soma no stream | Não há interface |
| TUI custom | tabela `custom_agents` | Subconjunto: sem conta, sem frota, sem MCP |

Um `AgentAdapter` que obrigue todos os métodos no primeiro dia ou reescreve cinco módulos de uma vez, ou fica cheio de `unimplemented!`. Os dois resultados são piores do que o `match` atual.

## Forma alvo

Dois níveis.

`AgentProvider` é dado. É o que hoje é `AgentDef`, com o layout de conta explícito em vez de um `match` de strings:

```text
id, label, command, version_flag
detect          continua em detector.rs, lendo o provider
skills_dir
profile:
  env_var
  login_command
  marker              caminho relativo à raiz que a variável aponta
  label_path
  default_home        como achar a conta do sistema: Home, Home/.claude, Home/.codex, XdgDataHome
sessions:       continua sendo um SessionSource no começo
resume
models
mcp
headless:       id do adapter já existente, não uma reescrita
```

`AgentAdapter` é o comportamento que não cabe numa linha: spawn headless, parse do stream, descoberta de sessão quando o `SessionSource` não bastar, leitura de usage. A primeira versão do trait é fina e tem default que chama o código de hoje. Só o provider que divergir implementa o método.

TUIs custom implementam o mesmo trait com os defaults vazios. Não ganham frota nem conta de graça.

## Migração, sem big bang

Cada fase deixa `cargo test` e o comportamento dos três providers que já têm conta iguais ao de antes. A suite de `agents/test.rs` já trava `env_var` e `supports_accounts`. Ela é o cinto.

### Fase A — layout declarativo, zero agente novo

Mover o `match` de `default_dir` e `system_marker_root` para campos de `ProfileDef`. Os três providers atuais preenchem o campo com o comportamento de hoje, inclusive o caso Claude em que o marcador da conta do sistema é lido no home e o das contas criadas é lido dentro do diretório.

Apagar o fallback `_ => home.join(".claude")`. Uma variável desconhecida tem que falhar na compilação ou no teste, não apontar a conta do Gemini para a pasta do Claude.

Nenhum `id` novo. Nenhuma tela muda.

### Fase B — sessão honra o diretório da conta

`session_file_for`, `discover_session_id_sync` e `get_session_title_sync` passam `profile` para Gemini e Kimi do mesmo jeito que já passam para Claude e Codex. Com `profile == None`, o caminho continua `~/.gemini`. Os testes de `session/test.rs` que usam um diretório temporário continuam válidos. Só se acrescenta um caso em que o profile não é o home.

Ainda sem ligar multi-conta. Isto evita o bug em que a segunda conta seria criada e a tab reabriria a sessão da primeira.

### Fase C — trait fino por cima do que existe

```text
trait AgentAdapter {
    fn def(&self) -> &'static AgentDef;
    fn launch_headless(...) -> Launch;   // delega ao HeadlessAgent atual
}
```

`adapter_for` vira uma tabela de adapters, não um `match` que conhece strings soltas. O `match` pode permanecer por uma fase como o miolo de cada adapter. `HeadlessAgent` não é apagado.

### Fase D — Gemini é o primeiro provider novo de verdade

Só depois de A e B. Aí sim `profile: Some` para `gemini-cli`. A UI, o SQLite, o PTY e a frota já ligam sozinhos: `supports_accounts` é `profile.is_some()`, e `env_for_account` já devolve `{ env_var: dir }`.

Contrato que o código de hoje não expressa, verificado na documentação e nas issues do Gemini CLI, não num teste deste repo:

- `GEMINI_CLI_HOME` substitui o home. O CLI cria `.gemini` **dentro** desse diretório. Não é `CLAUDE_CONFIG_DIR`. Parece o OpenCode: a variável aponta para o pai, o marcador inclui o subdiretório.
- Conta do sistema: variável ausente, dados em `~/.gemini`. `default_home` tem que ser o home do usuário, e o marcador `.gemini/<arquivo>`.
- Conta criada pela app: `GEMINI_CLI_HOME=<app data>/accounts/gemini-cli/<nome>`. O login grava em `<nome>/.gemini/`.
- Marcador candidato de OAuth: `.gemini/oauth_creds.json`. Há também `google_accounts.json`, e versões novas migram o token para o keychain do SO e tratam o arquivo como legado. O marcador precisa ser confirmado no `gemini` instalado nesta máquina antes de `profile: Some`. Sem essa confirmação, a tela mente sobre quem está logado. É a regra que o próprio `ProfileDef` documenta.
- Login: abrir `gemini` no PTY com a variável setada. Não há um subcomando estável equivalente a `codex login` que este código tenha verificado.
- Sessões: `session/title.rs` procura `projects.json` e `tmp/<slug>/chats/` debaixo do home Gemini. Na fase B esse home passa a ser `<profile>/.gemini` quando há conta, e `~/.gemini` quando não há.
- A frota já faz `env: ctx.account_env.clone()` no adapter Gemini. Não precisa de argv novo para a conta.
- MCP continua `None`. Gemini lê MCP de `settings.json`. Isso é outra etapa. Não bloqueia a segunda conta.
- Modelos continuam `Unknown`.
- `GEMINI_CLI_HOME` está em vias de ser deprecado no upstream do Gemini CLI em favor de `GEMINI_CONFIG_DIR`, `GEMINI_CACHE_DIR` e `GEMINI_TMP_DIR` (PR 23992, ainda não é o comportamento que o `gemini_home()` daqui assume). A fase D implementa `GEMINI_CLI_HOME`, que é o que as versões atuais documentam, e isola essa string num único campo para trocar depois sem caçar o repo.

Kimi fica de fora até existir uma variável verificada do mesmo jeito. Inventar uma conta que divide `~/.kimi` é pior do que não oferecer.

### Fase E — custom agents e usage

Custom agents passam a ser um provider com capabilities opcionais, não um segundo sistema. Usage vira método com default vazio. Claude continua sendo o único que responde de verdade até alguém implementar os outros.

## O que não fazer na primeira implementação

- Não unificar `HeadlessAgent`, `SessionSource` e `CustomAgent` num único enum de estratégias.
- Não mover `session/title.rs` para um crate novo.
- Não ligar `profile: Some` no Gemini no mesmo commit que mexe no fallback de `default_dir`, sem o teste do layout e sem o teste de que a descoberta de sessão recebe o profile.
- Não guardar token do Gemini. O diretório é do CLI. A ADE só aponta a variável.

## Primeira implementação real, na ordem

1. Fase A, com teste que falha se uma variável nova cair em `~/.claude`.
2. Fase B, com teste de sessão Gemini num diretório que não é o home.
3. Fase D, atrás de uma verificação manual do marcador no `gemini` desta máquina. Se o binário não estiver instalado, a fase D espera. A e B não dependem dele.
