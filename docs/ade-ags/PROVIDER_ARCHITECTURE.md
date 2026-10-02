# Provider architecture

Proposta para evoluir o registry atual até algo no formato `AgentProvider` / `AgentAdapter`, sem reescrever a app. As fases A, B e C estão no código. As fases D e E continuam proposta. Gemini segue com `profile: None`. O contrato da fase C está em [PROVIDER_CONTRACT.md](./PROVIDER_CONTRACT.md). O inventário do que mudou e do que ficou está em [PROVIDER_AUDIT.md](./PROVIDER_AUDIT.md).

## O que já é um provider, sem esse nome

`AgentDef` em `src-tauri/src/agents/registry.rs` é a linha declarativa. O frontend não tem uma segunda tabela. Contas, skills, resume e o estilo de MCP saem dessa linha. A frota pedia o `HeadlessAgent` com um `match` no `id`. Desde a fase C, `runs::agents::adapter_for` chama `agents::adapter_for` e fica com o que `headless()` devolver.

O que está espalhado, e é o problema real:

| Capacidade | Onde vive hoje | Por que não cabe num campo a mais |
|---|---|---|
| Detectar binário e versão | `agents/detector.rs` | I/O, timeout, regra especial do shell |
| Layout do home da conta | `DefaultHome` e `SystemMarkerRoot` em `ProfileDef`. `default_dir` só lê esses campos | Claude guarda `.claude.json` no home, não dentro de `~/.claude`. OpenCode aninha `opencode/` debaixo do `XDG_DATA_HOME`. Gemini aninha `.gemini/` debaixo do `GEMINI_CLI_HOME` |
| Achar e titular a sessão | `match` de `SessionSource` em `session/title.rs` | Cada CLI tem um formato. A fase B passou o diretório da conta a Gemini e Kimi. O parser continua |
| Lançar headless e parsear eventos | trait `HeadlessAgent`. O `match` do id saiu de `adapter_for` na fase C | Argv e dialeto JSON continuam sendo código, agora atrás de `headless()` |
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

`AgentAdapter` é o comportamento que não cabe numa linha. A fase C implementou a versão fina: `headless()`, `account_env()` e `assumes_installed()`, com default que não lança e não finge conta. O parse do stream continua em `HeadlessAgent`. A descoberta de sessão continua no `match` de `SessionSource`. Usage continua só em Claude. Não entrou no trait.

TUIs custom não implementam o trait nesta fase. `custom_capabilities` responde as mesmas perguntas, com frota e conta em falso. A fase E é que as aproxima do mesmo contrato.

## Migração, sem big bang

Cada fase deixa `cargo test` e o comportamento dos três providers que já têm conta iguais ao de antes. A suite de `agents/test.rs` já trava `env_var` e `supports_accounts`. Ela é o cinto.

### Fase A — layout declarativo, zero agente novo

Mover o `match` de `default_dir` e `system_marker_root` para campos de `ProfileDef`. Os três providers atuais preenchem o campo com o comportamento de hoje, inclusive o caso Claude em que o marcador da conta do sistema é lido no home e o das contas criadas é lido dentro do diretório.

Apagar o fallback `_ => home.join(".claude")`. Uma variável desconhecida tem que falhar na compilação ou no teste, não apontar a conta do Gemini para a pasta do Claude.

Nenhum `id` novo. Nenhuma tela muda.

Implementado. `default_dir` não faz mais `match` no nome da variável. Um perfil novo escolhe `DefaultHome` ou não compila. O teste `el_home_por_defecto_no_cae_en_claude` trava Claude, Codex e OpenCode e recusa `.claude` em qualquer outro perfil.

### Fase B — sessão honra o diretório da conta

`session_file_for`, `discover_session_id_sync` e `get_session_title_sync` passam `profile` para Gemini e Kimi do mesmo jeito que já passam para Claude e Codex. Com `profile == None`, o caminho continua `~/.gemini`. Os testes de `session/test.rs` que usam um diretório temporário continuam válidos. Só se acrescenta um caso em que o profile não é o home.

Ainda sem ligar multi-conta. Isto evita o bug em que a segunda conta seria criada e a tab reabriria a sessão da primeira.

Implementado na descoberta. Com `profile == None`, Gemini continua em `~/.gemini` e Kimi em `KIMI_CODE_HOME` ou `~/.kimi-code`. Com diretório de conta, Gemini lê `<profile>/.gemini` e Kimi lê `<profile>/sessions`. `gemini-cli` e `kimi-code` seguem com `profile: None` no registro.

### Fase C — trait fino por cima do que existe

Implementada. `AgentAdapter` em `agents/adapter.rs` não copia os campos da fila. Expõe o que realmente varia: `headless()`, `account_env()` e `assumes_installed()`. `capabilities()` é derivado da fila mais a existência do `HeadlessAgent`. Os seis providers de fábrica, inclusive bash e o Gemini sem binário instalado, estão num slice estático. `HeadlessAgent` não foi apagado.

O que não entrou no trait, de propósito: parsers de sessão, os dois formatos de MCP, a listagem de modelos e o consumo de Claude. Detalhe e o caminho para um provider novo em [PROVIDER_CONTRACT.md](./PROVIDER_CONTRACT.md).

### Fase D — Gemini é o primeiro provider novo de verdade

Não implementada. Em 2026-09-29 o comando `gemini` não estava instalado nesta máquina, e `%USERPROFILE%\.gemini` é estado do Antigravity, não um home do Gemini CLI. O registro segue com `profile: None`. Detalhe em [GEMINI_MULTI_ACCOUNT.md](./GEMINI_MULTI_ACCOUNT.md).

Só depois de A e B, e só depois do ensaio real de duas contas. Aí sim `profile: Some` para `gemini-cli`. A UI, o SQLite, o PTY e a frota já ligam sozinhos: `supports_accounts` é `profile.is_some()`, e `env_for_account` já devolve `{ env_var: dir }`.

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
3. Fase C, o contrato fino. Feita: registro estático, capabilities reais, frota e contas perguntam ao adapter. A fase D continua atrás de uma verificação manual do marcador no `gemini` desta máquina. O binário não está instalado; a fase D espera.
