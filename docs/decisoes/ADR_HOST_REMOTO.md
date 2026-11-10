# ADR — Host remoto e serviço em segundo plano (Fase 8)

- **Status:** Proposto / Recomendado
- **Data:** 2026-11-10
- **Autor:** Subagente de Design / Antigravity
- **Decisão base:** [HOST_REMOTO.md](./HOST_REMOTO.md)
- **Documentos de referência:**
  - [AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md)
  - [ARCHITECTURE.md](../ade-ags/ARCHITECTURE.md)
  - [AGENTS.md](../../AGENTS.md)

---

## 1. Contexto

### 1.1 Por que um host sem renderer?

O ADE AGS nasceu como uma aplicação desktop local-first baseada em Tauri 2 ([ARCHITECTURE.md](../ade-ags/ARCHITECTURE.md#L12-L20)). No arranjo original herdado, o ciclo de vida dos processos de agentes de código, terminais PTY, sessões de chat, rotinas agendadas e conexões SQLite está estritamente atrelado ao ciclo de vida do processo com interface gráfica (`ade-ags`).

Essa amarração traz problemas estruturais severos para a operação contínua e a colaboração remota:

1. **A regra de ouro de preservação de terminais:** Conforme estabelecido em [AGENTS.md](../../AGENTS.md#L34-L41) (§2.1 "Não derrubar os terminais do usuário"), fechar a janela, reiniciar a interface ou atualizar a aplicação instalada mata sumariamente o processo e, com ele, todos os PTYs e agentes em execução. O HMR do Vite e reinicializações de interface já derrubaram PTYs de missões em andamento ([AGENTS.md](../../AGENTS.md#L36)).
2. **A limitação do `--headless` atual:** A flag `--headless` presente em [run.rs](../../src-tauri/src/app/run.rs#L20-L26) não implementa um serviço em segundo plano real. Ela apenas inicializa o processo Tauri completo, oculta as janelas através de `window.hide()` e **desativa explicitamente** serviços vitais de segundo plano:
   - O agendador de rotinas ([run.rs](../../src-tauri/src/app/run.rs#L44-L46));
   - A fila durável de mensagens entre agentes ([run.rs](../../src-tauri/src/app/run.rs#L47-L48));
   - O observador de transcripts de chat ([run.rs](../../src-tauri/src/app/run.rs#L49));
   - A entrega de tarefas delegadas de filhos ([run.rs](../../src-tauri/src/app/run.rs#L50-L51));
   - O canal estruturado de transcripts das abas ([run.rs](../../src-tauri/src/app/run.rs#L52-L53));
   - O módulo do pet de tela ([run.rs](../../src-tauri/src/app/run.rs#L54-L55)).
   Ou seja, o `--headless` atual é um modo capado para testes de integração e CI, e não um daemon persistente ([HOST_REMOTO.md](./HOST_REMOTO.md#L191-L193)).
3. **Ponte com a interface gráfica (`bridge.rs`):** Diversos comandos que tocam abas ou o canvas (`tab.create`, `tab.close`, `design.*`, `portal.*`) dependem do store Zustand no frontend. O backend tenta comunicar-se com a janela via `bridge_call` e espera até 15 segundos ([bridge.rs](../../src-tauri/src/ipc/bridge.rs#L22-L25)). Quando não há janela visível ou aberta, o chamador aguarda os 15 segundos completos até receber um erro de timeout ([bridge.rs](../../src-tauri/src/ipc/bridge.rs#L88-L110)).
4. **Clientes móveis, web e acesso distribuído:** Para permitir que o usuário acompanhe missões, responda a pedidos de aprovação ou envie comandos pelo celular ou navegador sem manter uma janela desktop pesada aberta consumindo GPU e memória, é imprescindível um **ADE Host**: um processo servidor sem renderer, desacoplado do ciclo de vida das janelas ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L31-L39)).

### 1.2 Quem é dono do filesystem, dos PTYs e dos providers hoje?

Uma auditoria direta do código em `src-tauri/src/` confirma os proprietários atuais dos recursos:

- **Filesystem e Banco de Dados (`~/.ags/data.db`):**
  - O banco de dados SQLite é aberto na pasta do usuário em `~/.ags/data.db` (ou no caminho apontado por `ADE_AGS_DATA_DIR`) por `db_path()` em [connection.rs](../../src-tauri/src/database/connection.rs#L61-L65) e [datadir.rs](../../src-tauri/src/util/datadir.rs#L14-L22).
  - A conexão principal `DbConnection` é um `Arc<Mutex<Connection>>` em [connection.rs](../../src-tauri/src/database/connection.rs#L53-L55), configurada em modo WAL com timeout ocupado de 5 segundos ([connection.rs](../../src-tauri/src/database/connection.rs#L81-L103)).
  - Apenas o processo principal do Tauri possui e gerencia as migrações automáticas de schema (`PRAGMA user_version`) no arranque ([run.rs](../../src-tauri/src/app/run.rs#L77-L80)). Dois processos independentes não podem tentar migrar ou manipular o banco concorrentemente sem risco de colisão.
- **Terminais e PTYs:**
  - Pertencem exclusivamente à memória do processo Tauri. O registro de PTYs ativos é um `lazy_static!` global (`PTY_REGISTRY`, `PTY_BUFFERS`, `PTY_COUNTER`) em [pty_manager.rs](../../src-tauri/src/terminal/pty_manager.rs#L108-L112).
  - A contenção de processos filhos no Windows usa Job Objects (`terminal/containment.rs`).
  - No encerramento do processo, [shutdown.rs](../../src-tauri/src/app/shutdown.rs#L24-L35) executa `shutdown_once`, que invoca `kill_all_sessions()` em [pty_manager.rs](../../src-tauri/src/terminal/pty_manager.rs#L1304-L1313). Todos os descritores PTY são drenados e fechados, e os processos filhos são sumariamente encerrados. **Nenhum PTY sobrevive à morte do processo.**
- **Providers e Execução de Agentes:**
  - A definição canônica dos provedores de agentes (`claude-code`, `codex`, `opencode`, `gemini-cli`, `kimi-code`) reside em [registry.rs](../../src-tauri/src/agents/registry.rs#L53-L65) (`AgentDef`).
  - O isolamento de contas e variáveis de ambiente (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`) é gerido por [profiles.rs](../../src-tauri/src/accounts/profiles.rs#L29-L43).
  - A frota headless e os adaptadores de stream residem em `runs/` ([runs/mod.rs](../../src-tauri/src/runs/mod.rs#L1180-L1240) e [runs/adapters.rs](../../src-tauri/src/runs/adapters.rs)). O broker de permissões de ferramentas vive em memória ([runs/broker.rs](../../src-tauri/src/runs/broker.rs#L39-L50)).
- **Servidor IPC Local:**
  - O listener atual do IPC é inicializado somente após a restauração de janelas em [run.rs](../../src-tauri/src/app/run.rs#L58-L61) (`crate::ipc::start(app.clone())`).
  - Ele escuta exclusivamente em `127.0.0.1` com porta TCP efêmera escolhida pelo SO ([server.rs](../../src-tauri/src/ipc/server.rs#L55-L58)), acompanhado de um socket de credencial Unix (`~/.ags/ipc/<pid>.sock`) ou named pipe Windows com `PIPE_REJECT_REMOTE_CLIENTS` ([transport.rs](../../src-tauri/src/ipc/transport.rs#L226-L295)).
  - A autenticação é feita por um token UUID v4 gerado a cada boot ([server.rs](../../src-tauri/src/ipc/server.rs#L58)), compartilhado através de arquivos locais em `~/.ags/ipc.json` ([protocol.rs](../../src-tauri/src/ipc/protocol.rs#L20-L22)).

---

## 2. Opções de Arquitetura para o Host Persistente

Avaliamos quatro opções arquiteturais para desacoplar o host da janela:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Opção 1: Tauri Monolítico (janela oculta / tray)                            │
│ [ Runtime WebKitGTK / WebView2 ] ── [ Backend ade_ags_lib ]                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Opção 2: Binário Dedicado de Serviço (ade-host puro sem Tauri)              │
│ [ ade-host (Tokio Daemon) ] ◄── IPC Local ──► [ ade-ags (Thin Desktop UI) ] │
├─────────────────────────────────────────────────────────────────────────────┤
│ Opção 3: Abordagem Progressiva (ags host reaproveitando ade_ags_lib)       │
│ [ ags host (Daemon Headless) ] ◄── IPC / Socket ──► [ Clientes & Desktop ]  │
├─────────────────────────────────────────────────────────────────────────────┤
│ Opção 4: Supervisor de PTY Externo Dedicado (pty-shim / daemon isolado)     │
│ [ ade-pty-shim ] ◄── IPC ──► [ ade-host ] ◄── IPC ──► [ UI Desktop ]       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Opção 1: Tauri Monolítico em Background (Janela Ocultável / Modo Tray)

Nesta opção, o processo principal permanece sendo o executável Tauri padrão (`ade-ags`). Quando o usuário fecha a janela desktop, a janela não é destruída, apenas ocultada (`hide()`), mantendo um ícone na bandeja do sistema (system tray). O host e todos os serviços continuam rodando no mesmo processo do Tauri.

- **Prós:**
  - Menor custo de migração imediato: não exige refatorar chamadas a `tauri::AppHandle` nem decompor os comandos `#[tauri::command]`.
  - A ponte `bridge.rs` continua tendo um WebView ativo na memória para processar pedidos que tocam o store Zustand.
- **Contras:**
  - O processo carrega todo o subsistema gráfico (WebKitGTK no Linux, WebView2 no Windows, WebKit no macOS) mesmo sem janelas visíveis ([run.rs](../../src-tauri/src/app/run.rs#L83-L84)). Alto consumo de memória e vazamentos potenciais de webview.
  - Impossível de executar em servidores headless puros (como instâncias Linux em VPS ou contêineres sem servidor X11/Wayland instalado).
  - Instabilidades ou travamentos no renderizador web podem levar ao crash de todo o processo host.
  - Qualquer atualização do aplicativo instalado (instalação de nova versão `.app` ou `.exe`) exige encerrar o processo executável, matando instantaneamente todos os PTYs e agentes em execução ([AGENTS.md](../../AGENTS.md#L34-L38)).
- **Custo de migração:** Baixo.
- **PTYs e efeitos ativos no shutdown e no upgrade:**
  - *Shutdown:* [shutdown.rs](../../src-tauri/src/app/shutdown.rs#L24-L35) mata todos os PTYs via `kill_all_sessions()` ([pty_manager.rs](../../src-tauri/src/terminal/pty_manager.rs#L1304-L1313)).
  - *Upgrade:* Destrutivo. Atualizar o aplicativo requer fechar o app, encerrando todos os PTYs e tarefas ativas.
- **Impacto no app instalado e em `~/.ags`:**
  - Nenhuma alteração nos binários empacotados. `~/.ags` permanece inalterado.
- **Superfície de ataque:**
  - Ampla e arriscada. O runtime de WebView continua vivo com comandos Tauri registrados com capacidade curinga `"*"` ([capabilities/default.json](../../src-tauri/capabilities/default.json#L5-L7)).

---

### Opção 2: Binário Dedicado de Serviço (`ade-host` independente sem Tauri)

Nesta opção, cria-se um executável separado (`ade-host` ou subcrate dedicada), compilado sem nenhuma dependência do ecossistema Tauri. O `ade-host` é um daemon de console baseado puramente em Tokio, Rusqlite e portable-pty. Ele assume a propriedade exclusiva de `~/.ags/data.db`, dos PTYs, das rotinas, dos providers e da escuta IPC/RPC. O executável gráfico `ade-ags` passa a ser um cliente desktop leve que se conecta ao `ade-host` via IPC local (socket de domínio Unix ou named pipe).

- **Prós:**
  - Desacoplamento arquitetural limpo e definitivo: a interface gráfica torna-se apenas mais um cliente.
  - Extremamente leve e eficiente: roda nativamente em servidores headless, instâncias de nuvem, Raspberry Pi e VPS sem nenhuma dependência de interface gráfica.
  - A interface gráfica desktop pode ser fechada, reiniciada ou atualizada sem derrubar nenhum PTY ou agente em execução.
  - Superfície de ataque do daemon drasticamente reduzida (sem browser engine nem WebViews acopladas ao processo raiz do serviço).
- **Contras:**
  - Custo de migração muito alto: atualmente, centenas de linhas no backend dependem diretamente de `tauri::AppHandle` e `tauri::Emitter` ([run.rs](../../src-tauri/src/app/run.rs#L4), [dispatch.rs](../../src-tauri/src/ipc/commands/dispatch.rs#L85), [bridge.rs](../../src-tauri/src/ipc/bridge.rs#L19)).
  - Exige desacoplar a lógica de negócio dos comandos Tauri ou reimplementar os comandos de frontend para falar através do protocolo IPC/RPC do host.
  - Exige reestruturar o empacotador de distribuição do macOS (`.app`) e do Windows (NSIS) para instalar e orquestrar múltiplos executáveis como serviços/daemons.
- **Custo de migração:** Alto.
- **PTYs e efeitos ativos no shutdown e no upgrade:**
  - *Shutdown:* O host ganha ciclo de vida controlado (`stop`), com suporte a modo de drenagem (*drain*), listagem prévia de sessões ativas e exigência de confirmação humana explícita antes de derrubar processos ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L94-L96), [HOST_REMOTO.md](./HOST_REMOTO.md#L201-L206)).
  - *Upgrade:* Atualizações da interface desktop têm impacto zero nos PTYs. No upgrade do binário `ade-host`, os PTYs ainda são encerrados (salvo existência de supervisor externo), porém com drenagem controlada e sem interrupções acidentais por HMR.
- **Impacto no app instalado e em `~/.ags`:**
  - Exige novo binário no pacote ou gerenciador de serviços do sistema operacional (`launchd` no macOS, Windows Service ou Tarefa Agendada no Windows, `systemd` no Linux).
  - Em `~/.ags`, requer introdução de arquivo de lock exclusivo do host (`~/.ags/host.lock`) para prevenir inicialização duplicada.
- **Superfície de ataque:**
  - Mínima. O daemon expõe apenas interfaces IPC estritamente validadas e auditadas.

---

### Opção 3: Abordagem Progressiva Bifásica via Subcomando da CLI (`ags host`) compartilhando `ade_ags_lib`

O repositório já emite dois binários a partir do mesmo crate: `ade-ags` (a aplicação gráfica) e `ags` (a CLI em [cli.rs](../../src-tauri/src/bin/cli.rs#L1-L30)), configurados em [Cargo.toml](../../src-tauri/Cargo.toml#L7-L30) para compartilhar o mesmo crate de biblioteca `ade_ags_lib`.

Nesta opção, implementa-se o daemon como um subcomando do executável CLI existente: `ags host run`. Na biblioteca `ade_ags_lib`, desacopla-se o estado central dos módulos de backend (`DbConnection`, `PtyRegistry`, `Runs`, `Routines`, `PeerQueue`) de `tauri::AppHandle`, agrupando-os em uma estrutura unificada `HostContext`.

A transição ocorre em duas fases:
- **Fase A (Host Headless Local):** `ags host run` inicializa os serviços de backend (rotinas, observação de chat, canal estruturado, PTYs e IPC) sem abrir janelas e sem inicializar WebKit/WebView2.
- **Fase B (Cliente Desktop Híbrido/Conectado):** Quando `ade-ags` é aberto, ele verifica se o daemon `ags host` já está em execução localmente via socket Unix / named pipe. Se estiver, conecta-se como cliente leve; se não estiver, inicializa o host embutido (garantindo compatibilidade reversa sem quebrar a experiência do usuário durante a migração).

- **Prós:**
  - Entrega incremental e segura: permite validar o host headless em fatias pequenas sem quebrar a compilação nem a distribuição do aplicativo existente.
  - Não requer criar um crate ou binário novo no sistema de build: reaproveita o binário `ags` que já é compilado e colocado no bundle pelo `stage-cli` ([AGENTS.md](../../AGENTS.md#L143-L144), [Cargo.toml](../../src-tauri/Cargo.toml#L27-L30)).
  - Corrige imediatamente a falha do `--headless` atual, ativando rotinas, fila de agentes e canal estruturado sem janelas.
  - Pode rodar em servidores headless Linux executando apenas o binário `ags`.
- **Contras:**
  - Manutenção temporária de código de inicialização dual (modo embutido versus modo cliente-servidor) durante a fase de transição.
  - Ainda exige o esforço de engenharia para substituir gradualmente referências diretas a `AppHandle` no despachador por abstrações agnósticas de interface.
- **Custo de migração:** Médio e progressivo.
- **PTYs e efeitos ativos no shutdown e no upgrade:**
  - *Shutdown:* Fechar a janela desktop não afeta os PTYs se o `ags host` estiver rodando. O comando `ags host stop` lista PTYs e tarefas ativas antes de prosseguir.
  - *Upgrade:* Atualizar a aplicação visual não encerra o daemon em execução.
- **Impacto no app instalado e em `~/.ags`:**
  - Não adiciona novos arquivos binários ao pacote. Cria `~/.ags/host.json` e `~/.ags/host.lock` para orquestração da instância ativa.
- **Superfície de ataque:**
  - Reduzida no modo daemon (sem WebView). No modo desktop embutido transitório, preserva as características locais atuais até a transição completa.

---

### Opção 4: Supervisor de PTYs Externo Dedicado (Daemon Shim Isolado)

Nesta opção, separa-se a gerência de PTYs em um micro-daemon dedicado (semelhante ao funcionamento interno do `tmux`, `screen` ou do subsistema do terminal do VS Code/T3 Code), desacoplado tanto do servidor de aplicação quanto da interface gráfica.

- **Prós:**
  - Sobrevivência absoluta de PTYs: mesmo no upgrade ou falha do processo `ade-host`, os PTYs e processos de agentes permanecem vivos em segundo plano.
- **Contras:**
  - Complexidade de engenharia desproporcional para o escopo da Fase 8: exige protocolo de streaming multiplexado dedicado, sincronização complexa de buffers de scrollback entre processos e tratamento de diferenças profundas de SO (conPTY no Windows versus pseudo-terminais POSIX no macOS/Linux).
  - Alto risco de criação de processos zumbis ou descontrolados se a orquestração falhar.
- **Custo de migração:** Muito alto.
- **PTYs e efeitos ativos no shutdown e no upgrade:**
  - *Shutdown e Upgrade:* PTYs sobrevivem ao reinício do host e da interface.
- **Impacto no app instalado e em `~/.ags`:**
  - Exige empacotar e gerenciar um binário adicional de baixo nível (`ade-pty-shim`).
- **Superfície de ataque:**
  - Complexa devido à IPC bidirecional com passagem de descritores de arquivo ou streaming de I/O bruto.

---

### Comparativo Consolidado das Opções

| Critério | Opção 1 (Tauri Tray) | Opção 2 (ade-host Dedicado) | Opção 3 (Recomendada: ags host) | Opção 4 (PTY Shim) |
|---|---|---|---|---|
| **Custo de migração** | Baixo | Alto | Médio (incremental) | Muito alto |
| **Execução em servidor headless puro (Linux/VPS)** | Impossível (exige WebKit/display) | Nativa e excelente | Nativa e excelente | Nativa |
| **Resiliência a fechar/atualizar a janela de UI** | Média (janela só esconde) | Alta (janela é cliente) | Alta (janela é cliente) | Alta |
| **Preservação de PTYs ao fechar a janela** | Sim (janela oculta) | Sim (host independente) | Sim (host independente) | Sim |
| **Preservação de PTYs no upgrade do host** | Não (processo morre) | Não (processo morre) | Não (processo morre) | Sim |
| **Consumo de recursos sem janela** | Alto (mantém engine WebView) | Mínimo (~20-40 MB) | Mínimo (~20-40 MB) | Baixo |
| **Superfície de ataque no daemon** | Ampla (WebView + Tauri) | Estrita e auditada | Estrita e auditada | Mínima |
| **Impacto no empacotamento (`.app`/NSIS)** | Nenhum | Exige múltiplos executáveis | Nenhum (reusa `ags`) | Exige novo executável |

---

## 3. Requisitos de Segurança Mandatórios (Pré-Acesso Remoto)

Qualquer que seja a opção de implementação, **nenhum acesso remoto será habilitado** sem que todos os seguintes requisitos de segurança estejam rigorosamente implementados e verificados:

```
                  ┌─────────────────────────────────────────────────────────────┐
                  │             REQUISITOS MANDATÓRIOS DO HOST                  │
                  └─────────────────────────────────────────────────────────────┘
                                                 │
       ┌───────────────────┬─────────────────────┼─────────────────────┬───────────────────┐
       ▼                   ▼                     ▼                     ▼                   ▼
┌──────────────┐    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐    ┌──────────────┐
│  RPC & Versão│    │  Identidade  │      │ Pareamento & │      │ Autorização  │    │ TLS / Túnel  │
│  Semântica   │    │  por Par de  │      │  Revogação   │      │   por F-09   │    │  mTLS Seguro │
│  Incompatível│    │    Chaves    │      │   Imediata   │      │  Deny-by-Def.│    │  Anti-CSRF   │
└──────────────┘    └──────────────┘      └──────────────┘      └──────────────┘    └──────────────┘
       │                   │                     │                     │                   │
       ▼                   ▼                     ▼                     ▼                   ▼
┌──────────────┐    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐    ┌──────────────┐
│ Logs & Audito│    │  Expiração   │      │     Modo     │      │ Reconexão &  │    │ Guardas IPC  │
│  Sem Segredo │    │  de Sessão   │      │  Read-Only   │      │ Deduplicação │    │  Loopback    │
│  no Registro │    │  TTL e Idle  │      │    Estrito   │      │  request_id  │    │  Intocadas   │
└──────────────┘    └──────────────┘      └──────────────┘      └──────────────┘    └──────────────┘
```

### 3.1 Protocolo de RPC Versionado
- O protocolo de mensagens atual possui apenas `PROTOCOL_VERSION = 1` com conferência rígida de igualdade na CLI ([protocol.rs](../../src-tauri/src/ipc/protocol.rs#L135), [cli.rs](../../src-tauri/src/bin/cli.rs#L1587-L1592)).
- O protocolo remoto deve adotar versionamento semântico de contrato (`contract_version`) e negociação de capacidades na saudação inicial (`hello` / `handshake`).
- O host deve rejeitar clientes incompatíveis com mensagem clara e código de erro tipado, **sem jamais rebaixar silenciosamente os controles de segurança** ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L27, L48)).

### 3.2 Autenticação e Identidade por Ambiente
- O modelo local de token único em arquivo compartilhado ([server.rs](../../src-tauri/src/ipc/server.rs#L58-L66), [protocol.rs](../../src-tauri/src/ipc/protocol.rs#L20-L22)) é proibido para acessos remotos ([HOST_REMOTO.md](./HOST_REMOTO.md#L125)).
- Cada cliente remoto deve possuir uma identidade criptográfica própria (`principal_id`), baseada em par de chaves assimétricas (Ed25519). A chave privada reside exclusivamente no cofre/keyring seguro do dispositivo cliente; a chave pública correspondente é cadastrada no host durante o pareamento.
- A rota física (LAN, VPN, SSH, Relay) nunca altera a identidade do principal ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L25, L49)).

### 3.3 Pareamento e Revogação
- O pareamento de um novo dispositivo deve ser **iniciado e aprovado interativamente pelo usuário no host**.
- O convite de pareamento deve utilizar um código curto ou QR code descartável, de **uso único**, com tempo de expiração curto (máximo de 180 segundos), com limite rigoroso de tentativas incorretas (máximo de 3 tentativas antes de bloquear) ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L77-L84)).
- O host mantém a tabela de dispositivos autorizados (`paired_devices`) no SQLite local.
- **Revogação imediata:** Ao revogar um dispositivo pelo painel do host (`ags device revoke <id>`), todas as conexões e sessões ativas daquele principal são terminadas instantaneamente, impedindo reconexões futuras ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L81-L82)).

### 3.4 Autorização por Método e Workspace (Tabela do F-09)
- Atualmente, o despachador possui 219 métodos ativos que não validam identidade de chamada ([dispatch.rs](../../src-tauri/src/ipc/commands/dispatch.rs#L85-L115)), possuindo apenas controle parcial no `tab.send` ([guard.rs](../../src-tauri/src/ipc/guard.rs#L24-L33), [HOST_REMOTO.md](./HOST_REMOTO.md#L148, L179)).
- O host remoto deve adotar a tabela declarativa de autorização que está sendo elaborada no F-09 a partir do inventário de [HOST_REMOTO.md](./HOST_REMOTO.md#L301-L348):
  - Todo método é categorizado em classes de risco: `L` (leitura), `E` (escrita), `X` (execução/controle), `D` (destrutivo), `A` (aprovação), `S` (segredo), `M` (manutenção).
  - Mapeamento explícito para capacidades granulares: `session.observe`, `session.message`, `files.read`, `files.write`, `terminal.execute`, `approval.decide`, `device.observe`, `device.control`, `host.admin`.
  - **Política deny-by-default:** Qualquer método desconhecido, novo ou sem classificação explícita é recusado sumariamente antes da execução.
  - **Escopo por workspace:** Comandos de arquivo (`files.*`, `workspace.*`) são confinados estritamente às raízes dos workspaces autorizados, com resolução canônica de caminhos para impedir *path traversal*.
  - Comandos de aprovação (`approval.decide`) continuam recusados via rede se o dispositivo não tiver capacidade explícita de aprovador humano ([HOST_REMOTO.md](./HOST_REMOTO.md#L140, L158)).

### 3.5 TLS ou Túnel Criptografado
- O listener de rede não aceitará tráfego em claro.
- A camada de transporte deve utilizar TLS 1.3 obrigatório (com verificação mTLS baseada nas chaves trocadas no pareamento) ou rodar encapsulada em túnel autenticado ponto-a-ponto (WireGuard, Tailscale ou SSH) ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L80)).
- Proteção anti-CSRF e anti-DNS rebinding: validação estrita de cabeçalhos `Host` e `Origin` em todas as conexões HTTP/WebSocket, reaproveitando a lógica de `util::loopback_trust` ([HOST_REMOTO.md](./HOST_REMOTO.md#L145, L167)).

### 3.6 Logs e Auditoria
- Registro estruturado persistente de eventos de segurança em tabela `remote_audit_log` ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L99)).
- Campos obrigatórios: timestamp UTC, `principal_id`, `request_id`, método invocado, status da autorização (permitido/negado), código de erro e endereço de rede de origem.
- **Preservação de privacidade e segredos:** O log de auditoria **nunca** deve conter transcripts de terminais, credenciais, segredos do chaveiro ou o conteúdo bruto de arquivos ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L24, L99)).

### 3.7 Expiração de Sessão
- O token perpétuo que dura a vida do processo ([server.rs](../../src-tauri/src/ipc/server.rs#L66)) é restrito ao IPC local de máquina.
- Conexões remotas devem operar com tokens de sessão temporários com tempo de vida definido (TTL máximo de 24 horas para clientes móveis com renovação periódica; 1 hora para clientes web efêmeros).
- Desconexão e invalidação de sessão automática após período de inatividade configurável (ex.: 30 minutos sem batimento/heartbeat).

### 3.8 Modo Read-Only Estrito
- O host deve suportar concessão de capacidades em modo estritamente de leitura (`read_only`).
- Dispositivos com perfil somente leitura têm autorização concedida **apenas para métodos da classe `L`** ([HOST_REMOTO.md](./HOST_REMOTO.md#L131, L303)).
- Qualquer tentativa de disparo de métodos de escrita (`E`), execução (`X`), destruição (`D`) ou aprovação (`A`) é imediatamente bloqueada no despacho com log de auditoria.

### 3.9 Reconexão e Idempotência
- Cada chamada mutável ou de execução deve enviar obrigatoriamente um identificador único de requisição (`request_id` / UUID v4) gerado pelo cliente ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L47)).
- O host mantém cache de deduplicação das últimas requisições processadas para evitar execução duplicada de ações não idempotentes (`tab.send`, `git_push`, transações) em caso de falha de conexão e retransmissão.
- Eventos utilizam cursor sequencial numérico (`events.since` / `cursor_id`), permitindo ao cliente reconectado receber eventos perdidos sem precisar reiniciar telas ou canais ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L90)).

### 3.10 Prova de que o IPC Local Continua Fechado à Rede
- As seis guardas de regressão estática adicionadas em [ipc/test.rs](../../src-tauri/src/ipc/test.rs#L1694-L1775) permanecem como barreiras invioláveis no CI:
  1. `o_ipc_so_escuta_em_loopback`: Assegura bind exclusivo a `127.0.0.1:0` e ausência de `0.0.0.0` ou `UdpSocket` em `src/ipc/`.
  2. `o_pedido_sem_token_valido_e_recusado_antes_do_despacho`: Garante validação de token antes de qualquer comando.
  3. `um_token_de_outra_instancia_nao_vale_aqui`: Garante unicidade e comparação em tempo constante.
  4. `uma_linha_http_nao_vira_pedido_do_ipc`: Impede que tráfego HTTP web comum seja interpretado pelo listener do IPC local.
  5. `os_limites_do_canal_ficam_no_codigo`: Mantém travas de vagas (Slots), limites de leitura pré-token e timeouts.
  6. `o_handshake_e_o_socket_de_credencial_continuam_so_do_usuario`: Valida permissão estrita `0600` e rejeição de clientes remotos em pipes Windows.
- O endpoint remoto **não reutiliza** esse listener local. Trata-se de um serviço independente, com porta própria, controle mTLS e protocolo de capacidades.

---

## 4. Decisão Recomendada

### 4.1 Escolha da Arquitetura

Adota-se a **Opção 3: Abordagem Progressiva Bifásica via Subcomando da CLI (`ags host`)**, evoluindo de forma planejada em direção à arquitetura de serviços desacoplados da **Opção 2**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ARQUITETURA FINAL RECOMENDADA                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   [ Clientes Remotos ]       [ Cliente Desktop ]      [ CLI ags Local ]     │
│   (Web / Mobile / Thin)     (ade-ags / WebView UI)    (Terminal / Scripts)  │
│            │                         │                         │            │
│       TLS 1.3 (mTLS)            IPC Unix Socket         IPC Unix Socket     │
│     Capacidades / RBAC          PID Credencial           PID Credencial     │
│            │                         │                         │            │
│            └──────────────────┐      │      ┌──────────────────┘            │
│                               ▼      ▼      ▼                               │
│                         ┌────────────────────────┐                          │
│                         │   ADE HOST DAEMON      │                          │
│                         │   (binário ags host)   │                          │
│                         │                        │                          │
│                         │  * Tokio Core Runtime  │                          │
│                         │  * Dispatcher F-09     │                          │
│                         │  * SQLite (data.db)    │                          │
│                         │  * PTY Registry        │                          │
│                         │  * Runs & Rotinas      │                          │
│                         └────────────────────────┘                          │
│                                      │                                      │
│                                      ▼                                      │
│                         [ Sistema Operacional ]                             │
│                         Filesystem, PTYs, Keyring                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Justificativa da Escolha

1. **Pragmatismo e Segurança Operacional:** Permite construir e estabilizar o host headless sem interromper o uso diário da aplicação instalada e sem violar a regra de ouro de não quebrar terminais ([AGENTS.md](../../AGENTS.md#L34-L38)).
2. **Reaproveitamento de Build Existente:** O binário `ags` já faz parte do pipeline de compilação e empacotamento oficial do ADE AGS ([Cargo.toml](../../src-tauri/Cargo.toml#L27-L30), [AGENTS.md](../../AGENTS.md#L143-L144)). Não há necessidade de criar novos instaladores ou alterar a assinatura do aplicativo empacotado para introduzir o comando `ags host`.
3. **Resolução de Lacunas Atuais do Headless:** Corrige a deficiência estrutural de [run.rs](../../src-tauri/src/app/run.rs#L44-L56), permitindo que rotinas, observadores de chat e filas de peers rodem continuamente sem janelas abertas.
4. **Isolamento de Falhas:** Um travamento na camada de renderização React/Vite/Tauri não derruba o host, mantendo os processos de agentes executando de forma confiável.

### 4.3 O que Fica Explicitamente Fora do Escopo

- **O espelhamento de iPhone é separado:** O controle e espelhamento de tela do iPhone ([ESPELHAMENTO_IPHONE.md](../ade-ags/ESPELHAMENTO_IPHONE.md#L14-L30)) depende de túnel CoreDevice nativo da Apple, transporte de stream de vídeo RTP/HEVC em tempo real e injeção de eventos HID pelo helper dedicado `ade-iphone-mirror` ([shutdown.rs](../../src-tauri/src/app/shutdown.rs#L32)). Conforme deliberado em [HOST_REMOTO.md](./HOST_REMOTO.md#L229-L244), esse fluxo fica categoricamente fora dos primeiros estágios do host remoto e exige hardware Mac físico com o iPhone conectado por cabo ou Wi-Fi. Nenhum cliente remoto terá acesso ao aparelho sem capacidade específica `device.observe` / `device.control`.
- **Clientes Web e Mobile só vêm depois do contrato do servidor:** Não haverá desenvolvimento de frontends web ou aplicativos móveis nesta fase. Clientes externos dependem do contrato de RPC, pareamento, auditoria e TLS estarem 100% implementados e estabilizados no backend ([AMBIENTES_REMOTOS.md](../ade-ags/AMBIENTES_REMOTOS.md#L110), [HOST_REMOTO.md](./HOST_REMOTO.md#L299)).

---

## 5. Plano em Fatias Pequenas

O plano é dividido em fatias sequenciais estritas. **Toda fatia que abre ou altera portas de rede exige autorização (OK explícito) do usuário antes de sua execução.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      FATIAS DE IMPLEMENTAÇÃO                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 0: Inventário & Tabela de Autorização F-09 (sem rede)                │
│ └── Critério: 100% dos métodos classificados; deny-by-default coberto em CI │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 1: Host Local em Segundo Plano (ags host em loopback)                 │
│ └── Critério: Daemon roda sem janela; PTYs sobrevivem ao fechar a UI        │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 2: Cliente Desktop Conectado & Ajuste de Bridge (local)               │
│ └── Critério: UI conecta ao daemon; bridge responde erro sem esperar 15 s   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 3: Pareamento Criptográfico Local & Revogação (local)                 │
│ └── Critério: Chaves Ed25519 registradas; revogação corta sessões na hora   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 4: Listener de Rede Privada (LAN / VPN com mTLS)                      │
│ └── [EXIGE OK EXPLÍCITO] Critério: Porta de rede aberta; mTLS obrigatório   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 5: Clientes Thin (Web / Mobile)                                       │
│ └── Critério: Cliente consome RPC e opera sob menor privilégio (read-only)  │
├─────────────────────────────────────────────────────────────────────────────┤
│ Fatia 6: Túnel e Relay para Acesso WAN                                      │
│ └── [EXIGE OK EXPLÍCITO] Critério: Roteamento externo seguro e auditado     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Fatia 0: Inventário Exato e Tabela de Autorização F-09
- **Escopo:** Finalizar a classificação dos métodos em `dispatch.rs` (concluindo o trabalho iniciado no F-09 e no Anexo A de [HOST_REMOTO.md](./HOST_REMOTO.md#L301-L348)). Transformar o catálogo em código Rust puro com macro ou tabela declarativa associando cada comando a sua classe e capacidade necessária.
- **Critério de saída:** Teste unitário em `ipc/test.rs` que falha na compilação/teste se qualquer braço novo do despachador não possuir classificação e capacidade mapeada. Negação por padrão de qualquer método desconhecido.
- **Exige OK do usuário?** **Não.** (Mudança de código interna, sem abertura de rede ou quebra de comportamento).

### Fatia 1: Host Local em Segundo Plano (`ags host`)
- **Escopo:** Adicionar o subcomando `ags host` em [cli.rs](../../src-tauri/src/bin/cli.rs). Inicializar o runtime de backend de `ade_ags_lib` (SQLite, PTYs, rotinas, observador de chat e fila de mensagens) sem instanciar WebViews ou janelas Tauri. Escutar exclusivamente em socket Unix de domínio local / named pipe Windows com credenciais de PID.
- **Critério de saída:** O usuário pode iniciar o serviço com `ags host run`, fechar a aplicação visual e constatar que os PTYs de missões em andamento continuam ativos e respondendo a comandos da CLI `ags`.
- **Exige OK do usuário?** **Não.** (Opera estritamente em loopback e socket de credencial local).

### Fatia 2: Cliente Desktop Adaptado e Resolução de Bridge
- **Escopo:** Fazer a interface Tauri (`ade-ags`) detectar a presença do daemon `ags host`. Se presente, a interface conecta-se como cliente gráfico. Ajustar `bridge.rs` ([bridge.rs](../../src-tauri/src/ipc/bridge.rs#L88-L110)) para retornar imediatamente com erro `"nenhuma interface conectada"` para comandos de UI quando não houver janela aberta, em vez de prender o processo por 15 segundos.
- **Critério de saída:** Comandos de terminal e frota executados via CLI na ausência da janela respondem instantaneamente sem timeouts espúrios.
- **Exige OK do usuário?** **Não.** (Apenas lógica de IPC local).

### Fatia 3: Pareamento Criptográfico Local e Revogação
- **Escopo:** Criar a tabela `paired_devices` no SQLite e implementar o handshake criptográfico assimétrico (Ed25519) com convites de uso único, código curto e expiração de 180 segundos. Implementar o comando `ags device revoke <id>`.
- **Critério de saída:** Simulação de cliente pareado valida chaves com sucesso; o comando de revogação invalida o acesso do par imediatamente.
- **Exige OK do usuário?** **Não.** (Testado em transporte in-memory e socket local).

### Fatia 4: Listener de Rede Privada (LAN / VPN com mTLS)
- **Escopo:** Implementar o listener de rede dedicado no host para conexões via rede local ou VPN (Tailscale/WireGuard), com TLS 1.3 mútuo obrigatório, validação de certificados pareados e proteção contra ataques web (Host/Origin checking).
- **Critério de saída:** Dispositivo em outra máquina na mesma VPN conecta-se, autentica-se e recebe eventos autorizados sob política deny-by-default.
- **Exige OK do usuário?** **SIM, EXIGE OK EXPLÍCITO DO USUÁRIO.** (Abre portas de rede no sistema operacional).

### Fatia 5: Clientes Thin (Web e Mobile)
- **Escopo:** Construção da interface leve (web/mobile) conectando-se ao endpoint da Fatia 4, com suporte a modo read-only e aprovações interativas supervisionadas.
- **Critério de saída:** Cliente móvel visualiza o canvas e aprova pedidos sem que segredos ou credenciais do host saiam da máquina hospedeira.
- **Exige OK do usuário?** **Não.** (Reaproveita o listener já aprovado e configurado na Fatia 4).

### Fatia 6: Acesso Externo via Túnel Seguro / Relay (WAN)
- **Escopo:** Disponibilização opt-in de túnel seguro para acesso externo fora da rede local (ex.: Cloudflare Tunnel autenticado ou relay criptografado ponta-a-ponto da ADE).
- **Critério de saída:** Acesso externo funcionando com limitação de taxa (rate limiting), rotação de chaves e proteção contra negação de serviço.
- **Exige OK do usuário?** **SIM, EXIGE OK EXPLÍCITO DO USUÁRIO.** (Publica tráfego para a internet pública).

---

## 6. Riscos e Perguntas Abertas

### 6.1 Riscos Mapeados

1. **Concorrência e Disputa pelo SQLite (`~/.ags/data.db`):**
   - *Risco:* Se um usuário abrir o aplicativo legado enquanto o `ags host` estiver em execução, ambos tentarão gerenciar transações e migrações no banco SQLite, gerando erros `SQLITE_BUSY` ou inconsistências de schema.
   - *Mitigação:* Implementar um arquivo de lock de processo exclusivo com `flock` / `LockFileEx` (`~/.ags/host.lock`) em [connection.rs](../../src-tauri/src/database/connection.rs#L81) que impeça uma segunda instância de abrir o banco em modo proprietário.
2. **Ambientes Headless Puros sem Subsistema de Keyring:**
   - *Risco:* Em servidores Linux headless (VPS sem ambiente de desktop), bibliotecas como `keyring` dependem do Secret Service / D-Bus via `gnome-keyring`, que costumam estar ausentes ([ARCHITECTURE.md](../ade-ags/ARCHITECTURE.md#L100-L102)).
   - *Mitigação:* Não confirmado se os servidores pretendidos pelo usuário possuem D-Bus ativo. Deve-se prever fallback seguro de cofre em arquivo criptografado com chave mestra derivada de senha ou variável de ambiente protegida antes de implantar em Linux puro.
3. **Morte de PTYs em Upgrades do Binário do Host:**
   - *Risco:* Como os descritores de arquivo PTY residem na memória do processo (`PTY_REGISTRY`), reiniciar o `ags host` para aplicar uma atualização de versão ainda derrubará os PTYs abertos.
   - *Mitigação:* Implementar a política de drenagem graciosa com aviso explícito de sessões ativas antes de qualquer encerramento ([HOST_REMOTO.md](./HOST_REMOTO.md#L207-L215)), dando ao usuário a opção de aguardar a conclusão das missões.

### 6.2 Perguntas Abertas

1. **Granularidade do Escopo de Workspace:** O isolamento de arquivos deve ser restrito aos diretórios registrados na tabela `workspaces` do banco, ou deve permitir permissões granulares por pasta/arquivo? Como tratar symlinks apontando para fora do workspace?
2. **Evolução de Abas Sem Janela:** Comandos como `tab.create` hoje acionam a interface para montar componentes React e xterm.js. O host sem janela deve manter uma representação de abas puramente no backend (como PTY headless sem xterm.js), sincronizando com a UI quando ela conectar?
3. **Persistência de Transcripts para Clientes Thin:** Como manter e sincronizar o histórico de scrollback do terminal para clientes remotos sem estourar o limite de memória do host? Devemos persistir o log em disco por tarefa/sessão?
