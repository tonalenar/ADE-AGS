# Roadmap ADE AGS

## iPhone e iPad físicos ao lado do simulador

O seletor do nó iOS e do painel iOS do chat ganhou "Aparelhos" (os físicos do CoreDevice, com USB ou Wi-Fi, modelo e iOS) acima de "Simuladores". O aparelho escolhido aparece ao vivo na mesma moldura do simulador, com a linha de estado (ligado, reconectando, sem conexão) e reconexão sozinha quando o túnel cai. Sem aparelho pronto, um estado vazio animado ensina a ligar pelo cabo ou Wi-Fi, tocar em "Confiar" e ligar o Modo de Desenvolvedor. A conversa com o CoreDevice fica num helper Swift à parte (`ade-iphone-mirror`); o app decodifica o HEVC com o VideoToolbox e mostra a `IOSurface` numa camada nativa, como no simulador. Medido no Wi-Fi: ~60 quadros/s, chegada→quadro p50 ~3 ms. **Controle:** clique e arrasto tocam o aparelho e o teclado digita, pelo HID do CoreDevice; `ags device list` dá id estável, estado e transporte; `ags device` e `sim act` mantêm o alcance e a confirmação por aparelho (`type` pergunta sempre). MCP inclui `device_list`, `device_shot` e `device_action` pelo mesmo despachador. Skills globais agora chegam também às conversas ativas por protocolo; `ags-orchestrator` continua seletiva, não sempre ativa. A foto do agente só usa quadro posterior ao IDR de recuperação sem anomalias, senão `devicectl` captura independentemente; origem e duração ficam no log. O helper permite adaptação de resolução no HEVC para evitar o mosaico durante rolagem rápida. A camada nativa acompanha os timestamps RTP e suaviza a cadência dos quadros. O painel e o canvas mostram os FPS medidos. Como funciona, mapa das APIs e medições: [ESPELHAMENTO_IPHONE.md](./ESPELHAMENTO_IPHONE.md).

O painel agora atualiza manualmente a busca de aparelhos já conhecidos pelo CoreDevice (inclusive Wi-Fi) e pode pausar/reabrir a sessão ADE sem remover a confiança do Mac. A pausa tem uma única mensagem e uma ação clara para retomar. A moldura física acompanha a orientação dos quadros do aparelho; para girar um iPhone, é preciso girá-lo fisicamente e deixar o Bloqueio de Orientação desligado. Qualquer agente com o iPhone compartilhado pode listar apps e abrir, encerrar ou navegar para uma URL no aparelho, além dos gestos HID já existentes; as confirmações e a chave do painel continuam valendo. A skill global `jev-sim-use` orienta agentes de todos os provedores a usar `ags device`/`device_*` no iPhone físico; `sim-use ios-device tap` fica fora do caminho de controle geral.

## Modo chat (estilo T3 Code), experimental

- **Prévia por ação de projeto:** ações podem guardar uma URL HTTP(S) de loopback e abri-la por clique no Browser compartilhado da conversa ativa. O destino não é associado automaticamente a um processo ou porta; o detalhe está em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).

Uma casca de conversas ao lado das abas e do canvas, ligada em Configurações → Modo chat. `Chat | Abas | Canvas` e Ctrl+Shift+L alternam. Detalhes em [MODO_CHAT.md](./MODO_CHAT.md).

- **Conversas por TUI:** cada uma é uma aba de agente, lida do transcript numa timeline; o terminal fica numa gaveta, sem remontar.
- **Conversas por protocolo:** o Codex (`codex app-server`) e o Claude Code (`claude -p` em stream-json, com o modo Plano) falam direto com o app, com aprovações e perguntas no chat.
- **Projetos conhecidos na paleta:** `Ctrl+K` oferece “Nova conversa em …” para projetos locais conhecidos mesmo quando não há conversa aberta, mostra nome/ícone e caminho, e omite projetos arquivados.
- **Telas:** Configurações, Espaços (Missões, Frota, Squads…), Design e Dispositivos abrem dentro do chat. As Configurações têm a mesma tela nova em todos os modos.
- **CLI e MCP:** `ags chat …` e as tools `chat_*` (skill `ags-orchestrator` 1.55.0).
- **Tarefas em segundo plano:** o painel do Claude Code no chat. Mostra os subagentes e os shells em árvore, com o tempo correndo, o parar de cada tarefa (o `stop_task` do Claude), "Concluído" recolhido e o detalhe com a saída ou o que o subagente fez. O Codex entra pelos `collabAgentToolCall`; OpenCode, Cursor e Antigravity, pela ferramenta `task` da timeline, sem parar. Ver [MODO_CHAT.md](./MODO_CHAT.md#tarefas-em-segundo-plano-como-no-claude-code).
- **Política local de agentes por projeto:** o menu de configurações da conversa nova pode desativar provedores para uma pasta. A regra é aplicada no backend ao criar threads, enviar novos turnos, trocar de agente e iniciar PTYs de abas comuns do ADE; conversas TUI iniciadas pelo composer também são verificadas, e worktrees herdam a configuração da origem. Turnos já iniciados podem terminar. Abas de missão continuam sob as regras por papel da orquestração; a frota não recebe filtro por provedor, e comandos digitados manualmente dentro de um shell não são interceptados. A herança entre ambientes conectados permanece pendente. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Integração T3 Code:** o seletor da referência enviada pelo usuário reúne agente/provedor/modelo, busca, favoritos, esforço, acesso, conta e Standard/Fast quando suportado. Novas conversas podem salvar padrões locais por pasta para agente/modelo, esforço, acesso, Plano, Fast, worktree e modo estruturado (sem conta nem largura de interface). Ações de projeto guardam nomes e opções localmente e comandos no chaveiro do sistema; importações de `t3.json` são revisáveis, limitadas a 8 KiB e nunca ativam execução automática. Ações opt-in podem rodar após a criação explícita de worktree ou após settle confiável de conversa estruturada/Claude Code/Codex; cada uma usa processo contido cancelável, não o PTY da conversa, e settle revalida fila e aprovações. As ações do projeto ativo também aparecem na paleta global `>` com IDs que incluem projeto e script; cada execução relê o comando do chaveiro, revalida e abre um PTY dedicado. As Configurações permitem gravar um atalho por ação do projeto ativo; catálogo integral de comandos, suporte a settle em outras TUIs e sincronização entre ambientes seguem pendentes. Na conversa nova, Shift-clique seleciona modelos e abre a comparação existente com o pedido preenchido e anexos passados como caminhos de referência; citações e contas específicas ainda não entram nesse fluxo. A troca de agente funciona em rascunhos e conversas por protocolo; numa TUI aberta, trocar de provedor pede confirmação e abre outra aba com contexto recente limitado e marcado como não confiável, preservando o PTY original. O composer oferece sugestões `@`, `$`, `/`, busca de PRs abertos com `#`, edição de fila, preferência entre enviar agora e enfileirar durante um turno, e navegação ↑/↓ pelas mensagens anteriores; `/clear`, `/compact`, `/autocompact` nativo e `/goal` estão integrados onde há suporte. O ditado começou como protótipo local no macOS: usa reconhecimento no dispositivo, pode ser cancelado, para em 50 s e insere a transcrição no rascunho sem enviar; Windows/Linux e opções avançadas seguem pendentes. O limite de auto-compactação do Claude pode ser definido por perfil nas conversas estruturadas e nas TUIs: na TUI, a ADE passa `CLAUDE_CODE_AUTO_COMPACT_WINDOW` só ao processo, e o Claude executa sua compactação nativa. Opcionalmente, ao reabrir uma conversa estruturada ociosa, a ADE envia `/compact` se os tokens de entrada do último contexto atingiram o limite do perfil (ou 200 mil por padrão), sem turno nem aprovação pendente; esse modo segue desligado por padrão. Compactação agendada antes de expirar o cache continua pendente por falta de um horário confiável. Conversas estruturadas Codex/Claude Code/OpenCode e sessões TUI de Codex/Claude Code/OpenCode/Hermes podem delegar tarefas a qualquer executor disponível no roster pelo scheduler da ADE, com isolamento e orçamento existentes; o Codex TUI recebe MCP por overrides `-c` exclusivos do processo. O Kimi Code continua disponível como executor e pode usar comandos `ags` pela ferramenta Shell quando a skill `ags-orchestrator` estiver montada, mas a CLI atual não aceita MCP por processo; a ADE preserva intactas as configurações MCP global e do projeto. Antigravity `agy --print` também recebe o MCP por configuração temporária de cada turno e pode orquestrar chamadas ao scheduler. Abas TUI de Gemini, Kimi, Cursor, Antigravity e agentes customizados ainda não recebem MCP por sessão. PRs vinculados reaproveitam o Forge; fontes configuráveis, modo de aparência Sistema, importação/exportação de temas T3/VS Code, edição de paletas, movimento configurável, Side chat por protocolo e abas TUI e busca local no histórico dessas conversas foram adicionados. Conversas podem ser reordenadas por menu e arraste entre Fixadas e o projeto original, arquivadas localmente sem encerrar o agente, restauradas e desfeitas quando a ação é reversível; avisos de atualização de agentes ficam até a pessoa dispensá-los. Atalhos globais existentes aceitam até 20 regras contextuais `when` por ação, com operadores booleanos e contextos limitados e validados; combinações iguais só são aceitas quando as condições não se sobrepõem. A paleta aceita `>` para buscar somente ações da ADE, e a página de atalhos exibe e pesquisa os IDs estáveis existentes. Os IDs `navigation.back`, `navigation.forward`, `rightPanel.new`, `chat.find`, `chat.new`, `chat.newLocal`, `chat.newWithoutProject`, `thread.stop` e `thread.undo` já podem ser configurados; `⌘T`/`Ctrl+T` mostra o seletor de superfícies, e `⌘F`/`Ctrl+F` busca localmente as mensagens e os planos publicados que a timeline carregada expõe (protocolo: timeline local completa; TUI: trecho carregado de até 4 MiB). A busca ignora comandos e saídas de ferramentas; não inclui planos que o parser TUI não exponha nem históricos arquivados. A paleta oferece essas ações, conversa na pasta ativa ou sem projeto, interrupção da conversa focada e desfazer da última ação reversível; ainda faltam o catálogo integral de IDs e comandos do T3, compactação de Claude antes de expirar o cache e detectar conclusão do `/goal` do Claude, outros formatos TUI, referências internas persistentes (os cartões de rascunho já voltam à mensagem de origem), herança de configurações entre ambientes, rotas e serviço remoto, uso agregado multiambiente e hosts remotos para dispositivos. Ver [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Árvore do harness no chat:** o feed mostra recursivamente conversas descendentes, tarefas da Frota e tentativas de cada tarefa. `run_list_harness_graph` entrega threads, turnos, runs/tarefas e tentativas como nós tipados; cada processo tem uma linha durável em `run_attempts` e JSONL exclusivo por tentativa. `harness_execution_events` registra marcos semânticos de mensagens, turnos, ferramentas, aprovações, perguntas, subagentes e workers da Frota; a UI mostra a atividade recente da linhagem e atualiza após a gravação serial. O log guarda referências e metadados limitados, mantendo textos e saídas nas tabelas e arquivos de origem. No boot, turnos e tentativas da Frota são reconciliados em transações e aparecem como interrompidos, sem replay ou spawn automático. A inspeção de JSONL permanece disponível sob demanda (4 MiB/400 eventos). **Fase 6 (painel e sinal/ruído):** a árvore é expansível por teclado (`role=tree`), mostra tentativas, estado final e resultado desconhecido, e atualiza por `cc-harness-event` com cursor (`run_list_harness_graph(threadId, afterCursor)` devolve só o delta dos eventos); o progresso de baixo nível vira uma linha de resumo e não gera mensagem de chat. Contrato em [HARNESS_CONTRATO.md](./HARNESS_CONTRATO.md#14-fase-6-painel-do-harness-e-relação-sinalruído); sem prova visual ainda. Replay, recuperação de sessões de provider e o grafo imutável de `ExecutionNode`s seguem pendentes; detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#harness-multiruntime-arquitetura-e-paridade-alvo).
- **Ambientes remotos e serviço em segundo plano:** ainda não implementados. A proposta separa o host da janela, define RPC versionado e permissões por dispositivo antes de serviço local, pareamento, revogação, LAN/VPN, failover, clientes web/mobile e eventual relay. Não expor o IPC atual nem tratar `--headless` como daemon. A arquitetura e os critérios por fase estão em [AMBIENTES_REMOTOS.md](./AMBIENTES_REMOTOS.md).
- **Paleta de ações estilo T3:** a busca de ações `>` oferece o tema padrão e temas personalizados, seleção/editor de tema nas Configurações, ciclo de aparência Sistema/Claro/Escuro, alternância Chat/Abas, zoom de texto dos terminais, abertura do painel Time e ditado local no macOS. No modo Chat, ela também inicia uma nova conversa em cada pasta de projeto com conversa aberta, oferece o seletor nativo para adicionar outro projeto e abre o seletor nativo de anexos do composer visível. No workspace, alterna a gaveta de busca no conteúdo do projeto. O painel da conversa tem comandos pesquisáveis e atalhos configuráveis para alternar, fechar e maximizar/restaurar; os atalhos começam sem combinação para não capturar teclas usadas por readline ou pelas TUIs. A paleta e os atalhos também controlam a prévia do Browser visível: toggle no Chat/workspace, recarga, foco da URL e zoom, com ações direcionadas ao `viewId`; portais selecionados do Canvas aceitam recarga/foco/zoom, mas não são removidos pelo toggle. As ações contextuais só aparecem quando disponíveis. O editor de temas ainda não flutua nem inclui o inspector de cores do T3. O catálogo geral ainda precisa ser auditado contra o T3. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Uso por conversa:** o Resumo separa o contexto atual do total informado pelo agente, mostra a divisão por entrada/saída/cache/raciocínio quando o provedor a envia, indica a cobertura dos detalhes e avisa se a timeline TUI está truncada. As categorias podem se sobrepor, o ACP ainda é experimental e o ADE não estima custos. Preços e agregação histórica por provedor, conta e projeto permanecem pendentes.
- **Comandos do composer e da paleta:** `/plan` alterna o modo da ADE quando o agente suporta, não é enviado ao provedor quando digitado sozinho e só troca uma conversa aberta entre turnos/sem aprovação pendente. A configuração pode ocultar skills do menu `/` sem desativar o seletor `$`. A paleta oferece reiniciar uma sessão TUI conhecida somente quando ela está ociosa e sem permissão pendente; a sessão é retomada pelo mecanismo existente. Comandos anunciados por uma sessão OpenCode ACP v1 ativa agora aparecem no grupo “Provedor” do menu `/`; cada snapshot substitui o catálogo e escolher um item preenche `/<nome>` para revisão e envio normal. No Claude Code, as conversas estruturadas recebem os comandos do `initialize` e o menu `/` mostra também as skills do disco (usuário, projeto e plugins habilitados) antes de o agente informar a lista; `.agents/skills` não entra. O Codex também mostra as skills dele no `/` (`skills/list` do app-server e varredura de `.agents/skills`), inseridas como `$nome`; Cursor e Antigravity ficam de fora até haver captura da invocação. Captura real do Codex e o catálogo completo de ações T3 continuam pendentes. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Busca, código e revisão de PR:** `⌘F`/`Ctrl+F` percorre nomes e linhas do patch e o conteúdo atual dos arquivos modificados/não rastreados. No Forge, o detalhe do PR tem abas Conversa e Código; o corpo é carregado sob demanda no SHA da cabeça, e a busca percorre os arquivos alterados. O número de um PR visível pode ser copiado pelo botão, pela paleta ou por atalho configurável, sem atalho padrão. A aba Código prepara comentários em linhas adicionadas, removidas e de contexto; a pessoa pode editar os rascunhos, e a publicação é explícita. O Rust confirma SHAs, arquivo e linha contra o diff atual. GitHub/Gitea agrupam comentários e permitem comentar, aprovar ou solicitar alterações; GitLab cria uma discussão por linha, também permite aprovar com SHA e preserva rascunhos não enviados em falha parcial. O painel de discussões lista threads, abre a linha no diff, permite responder, resolver e reabrir em GitHub, GitLab e versões compatíveis do Gitea. O Rust mantém o token fora do frontend e aplica limites para leitura e envio. A busca local do Diff do chat continua restrita ao repositório e limitada a 1 MiB por arquivo, 8 MiB e 500 arquivos. Permanecem pendentes navegação de símbolos e teste autenticado com os provedores; GitLab não oferece solicitar alterações pela API usada. Matriz e limites completos em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Navegação rápida estilo T3:** `⌘/Ctrl+1…9` abre as conversas correspondentes nas seções abertas da sidebar; com o seletor aberto, escolhe uma opção do catálogo filtrado; com a paleta aberta, executa o resultado correspondente. A paleta e os atalhos configuráveis também podem focar o workspace aberto seguinte/anterior em ordem alfabética, consultando as janelas vivas no momento do comando; se houver várias janelas no workspace escolhido, foca a primeira por rótulo nativo. A ação não abre nem fecha sessões. A busca normal da paleta também encontra conversas abertas pelo título, agente, pasta, equipe ou papel, arquivos pelo nome e caminho no workspace ativo, mensagens estruturadas ativas e concluídas e transcripts TUI abertos de Claude Code/Codex. A busca de arquivos respeita `.gitignore`, ignora `.git` e `node_modules` e limita tempo, entradas e resultados. Selecionar uma fala de conversa concluída a reabre e salta à mensagem. A busca de conteúdo também indexa sob demanda sessões TUI fechadas de Claude Code, Codex, Gemini CLI, Hermes e OpenCode; o índice é temporário em memória e resultados respeitam workspace, visibilidade e estado fechado. Kimi e agentes customizados continuam fora por não terem parser confirmado. Conversas TUI usam a ref unificada da ADE e abrem no workspace, enquanto conversas por protocolo vão ao Chat, carregando a lista local de protocolos quando necessário. O app só captura o acorde quando existe um destino na posição, e a conversa selecionada rola para a área visível.
- **Ações da conversa selecionada:** `thread.pin` fixa ou desafixa a ref unificada atual (TUI ou protocolo) pela paleta e por atalho configurável, sem combinação padrão; exige a casca Chat, revalida a conversa aberta e só muda a preferência local da barra.
- **Prompt stash por comando:** `composer.stash` oferece salvar, abrir ou restaurar o stash do composer visível pela paleta e por atalho configurável, sem combinação padrão. A paleta mostra a ação atualmente disponível no botão existente e o atalho exige foco no composer.
- **Comandos de envio do composer:** `composer.sendAlternate` alterna a ação de enviar/pôr na fila respeitando a preferência atual; `composer.sendBackground` inicia um rascunho de conversa em segundo plano sem time e mantém outro rascunho vazio; `composer.sendAndNewThread` envia ao fio atual e só abre um rascunho local quando o callback não recusa a mensagem. A paleta e o catálogo de atalhos só oferecem cada ação quando o composer visível a aceita. ⌘/Ctrl+Enter compartilha o envio alternativo e o envio em segundo plano em contextos exclusivos; no macOS, Cmd+Option+Enter envia e abre conversa nova. O envio/novo fio fica sem atalho padrão em Windows/Linux para manter a proteção Ctrl+Alt/AltGr, e pode ser configurado com outra combinação. Erros síncronos preservam o rascunho; falhas assíncronas continuam seguindo o contrato já existente de cada motor. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Stash de rascunhos no estilo T3:** `⌘/Ctrl+S` guarda explicitamente texto, referências de anexos e citações no chaveiro do sistema, sem autosalvar. Até 10 itens de 32 KiB cada; resumos não incluem texto nem pasta de origem. Restaurar carrega para revisão, mantém o stash salvo e não envia; somente Remover apaga. A restauração espera a inspeção dos anexos, avisa se o composer mudar e pede confirmação em outra pasta exibindo apenas os nomes de origem e destino. Anexos continuam nos caminhos locais; citações guardam texto e comentário, com link à origem só na mesma conversa. Detalhes e limites em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Adiamentos de conversas no estilo T3:** a sidebar permite adiar com durações e horários diários configuráveis em Configurações → Modo chat; as opções são ordenadas pelo próximo vencimento, e data/hora personalizada também está disponível. “Acordar agora” traz a conversa de volta sem encerrar o agente. Fios estruturados despertam em novo pedido, falha ou mensagem do usuário; TUI desperta em novo pedido de permissão, resposta ou mensagem enviada/enfileirada. Os prazos ficam locais; segue pendente um sinal confiável de falha para TUI. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Navegador inspirado no T3 Code (em andamento):** a conversa já oferece mini preview flutuante sobre a mesma página `BrowserTab` e `viewId` do painel. A barra pesquisa com DuckDuckGo ou o mecanismo escolhido (Google, Bing, Brave Search, Kagi, Ecosia ou URL personalizada com `%s`). Links HTTP(S) comuns podem abrir no sistema (padrão) ou no Browser da ADE; login e atualização continuam externos. A página inicial reúne oito páginas recentes por perfil e servidores locais detectados; parâmetros de consulta e fragments não entram no histórico. No WebView2 do Windows, conversas/agentes têm perfis persistentes isolados; o seletor permite voltar ao perfil padrão compartilhado, criar, renomear e remover perfis da ADE sem perder a sessão. A importação do Firefox entrou como primeira fatia: cópia única, revisão por domínio e gravação cifrada no proxy de preview (Configurações → Geral → Preferências). Chromium, Safari e os perfis do WebView2 seguem pendentes; no WebView2, os cookies persistidos ficariam fora do chaveiro, contra a regra de segredos da ADE. O modo WebView2 só aparece no Windows; em macOS/Linux, páginas externas do Browser continuam no proxy. Restam a importação dos demais navegadores, a validação do contrato colaborativo e a abertura opcional como navegador padrão. O plano e os limites por sistema estão em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#plano-do-navegador-inspirado-no-t3-code).
- **Captura para análise visual:** o composer salva um SnapShot PNG em Imagens/ADE AGS (padrão: display principal; outra tela ou janela pelo seletor ao lado da câmera) e o anexa ao rascunho; o painel de dispositivo também grava vídeo nativo de iPhone/iPad físico, simulador iOS e Android. A gravação do Mac usa ScreenCaptureKit e exige permissão de tela e macOS 15+. O vídeo fica local e só é enviado se a pessoa enviar o rascunho. No macOS, **Cmd+Shift+S** faz a captura padrão (tela principal) no composer visível (atalho editável), e uma captura ainda não enviada sobrevive à troca de conversa e ao recarregar. A captura de outra tela (só com duas telas, pela numeração documentada do `screencapture -D`) e de janela, com app e título no JSON ao lado do PNG, está implementada e ainda não verificada com monitores e janelas reais. Windows/Linux, árvore de acessibilidade e OCR da captura seguem pendentes. Ver [GRAVACAO_DE_TELA.md](./GRAVACAO_DE_TELA.md).
- **Composer do chat:** as mensagens enfileiradas podem ser editadas no próprio item; o texto muda sem alterar posição ou prioridade. No macOS, `Cmd+Shift+D` inicia/encerra o ditado no composer focado, e `Esc` descarta a captura sem transcrição.
- **Terminal do chat para o agente:** de uma conversa, `ags tab create --agent bash --initprompt "…"` (ou `--in-chat`) roda o comando no terminal do painel direito, o mesmo em que a pessoa digita; `tab send`/`tab output` seguem nele. Sem terminal, o comando vai num bloco ```bash para o **Rodar**. Skill 1.50.0. Ver [MODO_CHAT.md](./MODO_CHAT.md).
- **Time único (E2, backend):** `chat_team` ganha `origin` (`chat`/`canvas`/`mission`), `board_key` e `mission_id`; `chat_team_promote` (coroa do canvas vira time, só linhas), `chat_team_unlead` (coroa tirada mantém o time), `chat_team_lead` e `chat_team_rebind`. `ags team list` mostra a origem (skill 1.46.0). O espelho no front é a E3; a missão é a E5. Ver [MODO_CHAT.md](./MODO_CHAT.md).
- **A conversa segue o modo:** seleção única (`selectedRef`/`selectConversation`) em Chat, Abas e Canvas; `Board.threads` e o cartão da conversa por protocolo no canvas; `ProtocolPane` nas Abas para qualquer conversa. Ver [MODO_CHAT.md](./MODO_CHAT.md).
- **Time único (E3, espelho canvas → chat):** `promotePlan` promove a coroa de um canvas de pasta ou `#c:` a time do chat quando a pessoa coroa ou liga algo (nunca no boot, nunca `#m:`, nunca lança processo); tirar a coroa tira só o papel de orquestrador (`chat_team_unlead`); o invariante de um time só conta também a missão. O nó de conversa por protocolo no canvas ficou de fora. Ver [MODO_CHAT.md](./MODO_CHAT.md).

- **Time único (E2, backend):** `chat_team` ganha `origin` (`chat`/`canvas`/`mission`), `board_key` e `mission_id`; `chat_team_promote` (coroa do canvas vira time, só linhas), `chat_team_unlead` (coroa tirada mantém o time), `chat_team_lead` e `chat_team_rebind`. `ags team list` mostra a origem (skill 1.46.0). O espelho no front é a E3. **Missão no chat (E5):** `chat_team_mission_mirror`/`_unmirror` gravam e tiram a linha `origin='mission'` ao iniciar/fechar a missão em terminais; grupo "Missão X" com selo na sidebar (chat, Abas, Canvas) e criar/iniciar missão também no chat. A missão segue dona do motor. Ver [MODO_CHAT.md](./MODO_CHAT.md).

## Retomada e estado (pontos 15, 8 e 6 do deepseek-harness)

- **Armado não sobrevive ao reinício:** o que foi armado antes do boot (Vigia de missão e de time de conversa, rotina com catch-up, rodada de correção automática de run antigo) espera o botão **Retomar automação** (Missões, QG e barra do canvas). O fechamento antecipado e o "Decisão pendente" do Vigia não se repetem mais ao reabrir.
- **Integrante `provisioning`:** gravado antes do worktree e da aba (missão) ou da conversa (time do chat), reconciliado no boot para `active` ou `failed`; nomes nunca reutilizados. Migração só aditiva (`mission_member_state`, `chat_team_provision`).
- **Escopos de escrita:** `Escopo:` na delegação e `write_scopes` no `run_plan`; o canvas e o QG avisam quando duas tarefas em andamento se sobrepõem. Só aviso.
- Detalhe em [RETOMADA_E_ESTADO.md](./RETOMADA_E_ESTADO.md); skill `ags-orchestrator` 1.44.0.

## Processo e qualidade (pontos 23–25 da análise do deepseek-harness)

- **Postmortems numerados** em [postmortem/](./postmortem/README.md): 0001 Vigia segundos × ms (A1), 0002 HMR derrubando PTYs, 0003 sessão `opencode_stream` (A2), 0004 avisos repetidos do Vigia.
- **Fingerprint** SHA-256 do schema SQLite e do protocolo IPC, com registro de reconhecimento obrigatório no CI: [FINGERPRINT.md](../decisoes/FINGERPRINT.md).
- **Bench de complexidade** com gate por razão e orçamento calibrado (`digest`, transcript do canal, scrollback do PTY): [bench/COMPLEXIDADE.md](./bench/COMPLEXIDADE.md). Achou e corrigiu um O(n²) no `digest` (13,26× → 1,22×).

## Conector opcional de leitura do ai-memory

Backend com detecção de versão, status e leitura de bastões/páginas por subprocesso, sempre marcado `UNTRUSTED`. Não instala, captura, aceita bastões nem importa memória. Sessões recentes usam bridge MCP temporário com workspace/projeto explícitos e apenas `memory_briefing`. Novas abas do Claude podem somar MCP session-aware e hooks nativos; Codex/OpenCode usam intermediário MCP com workspace/projeto fixos, somente quando a pasta identifica um único projeto, com ajuste `ai_memory_tabs_enabled` e sem escrita nas configurações globais dos agentes. A ação explícita “Continuar com outro agente” apresenta preview não consumidor e, após confirmação, abre uma nova aba Claude via `ai-memory run`, preservando a origem; sem handoff abre normalmente. Contrato dos comandos e DTOs em [AI_MEMORY_CONNECTOR.md](./AI_MEMORY_CONNECTOR.md).

## Computer use em múltiplas superfícies — iOS

Núcleo Rust injetável e `ags sim act`: OCR local + decisão textual Jev por rótulos e caixas + reserva visual para ícones sem nome ou texto ambíguo + HID do simulador e do iPhone físico. A rota textual evita enviar a foto quando os rótulos bastam; a latência real ainda não foi medida, revisão antes de agir, confirmação humana na UI e guardas de privacidade dos preenchimentos. No iPhone físico, a conferência antes do HID aceita pixels iguais ou, em telas animadas, a mesma lista completa de rótulos e caixas para rolagens e cliques nomeados; ícones sem rótulo e digitação exigem pixels iguais. O Jev recebe instrução para ignorar movimento fora do estado relevante ao objetivo. `ags desk act` (tela do Mac, com consentimento por objetivo) e o reconhecimento de conversas por protocolo em `sim act`/`desk act` entraram em seguida; árvore AX e navegador externo continuam pendentes. MCP tem tools equivalentes ao `ags device`, com mesmas guardas e escopo. A captura física rejeita quadros após anomalia e usa `devicectl` como reserva, registrando fonte e duração. Skills sempre ativas chegam a chats ativos sem aba TUI, enquanto `ags-orchestrator` segue seletiva. **Pendente nesta entrega:** E2E supervisionado com Jev no iPhone real e comparação medida do tempo completo iPhone × simulador; não contar mocks como validação nativa. Contrato e auditoria em [COMPUTER_USE_SUPERFICIES.md](./COMPUTER_USE_SUPERFACES.md).

## Skills de computer use embutidas e o simulador mais firme

`jev-sim-use` (0.4.2) e `agent-desktop` (v1.2.0) vêm com o app, fixadas por tag, commit e SHA-256, e se atualizam com ele. Nascem ligadas para todos os agentes pela chave nova "Ativa em todos os agentes" do painel de Skills. Elas complementam o `act` nativo: leem a árvore de acessibilidade e cobrem o Android; a ação continua no `act`, com confirmação e privacidade. Detalhe em [SKILLS_TERCEIROS.md](./SKILLS_TERCEIROS.md).

No `sim act`:
- um alvo sob o teclado, sob a barra flutuante ou cortado na borda leva primeiro uma rolagem (`reveal`);
- tocar numa tecla sempre pede a pessoa;
- `--expect visual:changed|darker|lighter` confere pelos pixels (o tema que só troca a paleta);
- `report.effects` mostra o efeito de cada ação.

No painel Decisões, a concordância deixou de contar os pontos sem heurística, que derrubavam o número para 1%.

## CLIs fora do PATH e instalação pela ADE

No macOS a lista e o terminal acham o Claude do aplicativo e o `cursor-agent` sem estarem no PATH. O Cursor entra na fábrica sem sessão, conta isolada nem MCP. A tela de Agentes instala Codex, Gemini e Kimi com o comando npm/bun já fixo; Claude, OpenCode, Hermes, Cursor e Antigravity só mostram o comando, sem executá-lo. Detalhe em [AGENT_UPDATES.md](./AGENT_UPDATES.md).

Os avisos de atualização dos agentes permanecem na tela até a pessoa fechá-los e não somem quando chegam outros avisos; a pilha pode ser rolada.

## Canal estruturado em paralelo ao terminal

O estado das abas de Claude Code e Codex lido do transcript que a própria TUI grava (turno aberto ou
encerrado, ferramentas pendentes, pergunta com opções, tokens), com a tela como reserva: segura a
entrega de mensagens e as cutucadas do Vigia com o turno aberto (modo `veto`, padrão), `ags tab state`,
e aprovações e perguntas dos integrantes como pendências no SQLite (`ags peer pending`/`answer`).
Achados por agente, desenho e limites em [CANAL_ESTRUTURADO.md](./CANAL_ESTRUTURADO.md).

## Fila de mensagens entre agentes durável e editável

Toda mensagem entre agentes tem id e registro no SQLite (`peer_messages`), a entrega sobrevive ao
reinício, `--id` torna o reenvio idempotente e o selo "N na fila" deixa o usuário editar, reordenar,
cancelar ou enviar já. Detalhes em [FILA_DE_MENSAGENS.md](./FILA_DE_MENSAGENS.md).

**Etapa 2 do harness do modo chat — entrega confiável a conversas do time.** A mensagem para uma conversa
por protocolo (`thread:`) entra na mesma fila, com um consumidor por destino (ordem, retry só do que não saiu,
recuperação por marcador `#id` no reinício), trava de envio por conversa, aviso de falha também para quem
pediu de dentro de uma conversa, `ask` ancorado na mensagem (`replies`, `status: failed`, repetição junta-se à
mesma espera) e `ags peer receipt`. Fica para a etapa 3: retomada com aviso, bolha só quando o turno começa,
permissão no backend, `restart_active`, painel da fila para conversas.

## Etapa 20 — ponto 1: notificações com identidade ADE AGS

AUMID explícito antes das janelas, atalho por usuário com o bot e reparo idempotente,
toast Windows com identidade estável em dev/instalado e clique no destino exato.
O identifier Tauri foi preservado. Contrato, testes e roteiro manual em
[NOTIFICATIONS_WINDOWS.md](./NOTIFICATIONS_WINDOWS.md).

## Etapa 20 — ponto 5: API de revisão de todas as missões

Comando aditivo `memory_review_summary_workspace` agrega as missões com propostas
pendentes preservando evidência e classificações do resumo existente. Somente lê;
decisões permanecem explícitas por usuário. Contrato e limites em
[MEMORY_REVIEW_WORKSPACE.md](./MEMORY_REVIEW_WORKSPACE.md).

## Etapa 15 — início rápido (ponto 1)

Implementado em `feat/etapa15-inicio-rapido`: preparação persistida e idempotente de um worktree/branch por integrante (inclusive Orquestrador e recruits de missão), a partir de origin/master; junction de dependências e target Cargo isolado; contexto de precheck/memória preenchido para toda a equipe; briefing exige delegação em ~2 min antes de explorar e membros aguardam a tarefa. QG e CLI mostram `firstDelegationMs` e sua fonte real/histórica, preservando ausência em cinza. Schema v32 aditivo e testes de migração, isolamento, retry e lançamento. Comparação posterior em missão real depende de executar o app atualizado; não foi inventado ganho. Contrato e evidências em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

Ordem técnica. Sem datas. Cada etapa assume a anterior pronta o bastante para não inventar um segundo mecanismo paralelo.

A base é o ADE AGS 1.8.7 neste fork. O mapa do que já existe está em [ARCHITECTURE.md](./ARCHITECTURE.md).

## 1. Bootstrap Windows

Fundação desta etapa: fork, clone, branch `feat/ade-ags-bootstrap`, baseline de build e estas notas.

Depende de: nada no código. Fecha quando o app Windows sobe a partir deste clone e o resultado está em [BASELINE.md](./BASELINE.md).

## 2. Provider / Agent abstraction

Tornar o registry capaz de descrever um provider sem `match` de strings para o layout da conta, e fazer a descoberta de sessão receber o diretório da conta para todos os agentes de fábrica.

Depende de: 1. Não depende de Gemini instalado. Detalhe em [PROVIDER_ARCHITECTURE.md](./PROVIDER_ARCHITECTURE.md), fases A–C.

## 3. Multi-account padronizado

O mecanismo atual (diretório por conta, uma variável por processo, login no PTY, sem a ADE guardar segredo) passa a ser o contrato de qualquer provider com `profile`. Claude, Codex e OpenCode continuam iguais. O fallback que manda variável desconhecida para `~/.claude` deixa de existir.

Depende de: 2.

## 4. Gemini multi-account

`GEMINI_CLI_HOME` como home falso, dados em `<home>/.gemini`, sessões lidas desse diretório, marcador de login confirmado no CLI real. Kimi só entra se a mesma verificação existir.

Depende de: 3, e de um `gemini` instalado para confirmar o marcador. Sem o binário, a etapa não é adivinhada.

## 5. Mission Engine

Uma missão é o objeto persistente já implementado: objetivo, pasta, restrições, estado, e o conjunto de tasks. Por baixo, reusa `runs` / `tasks` / `task_deps`. Não cria um segundo banco.

Depende de: 3. Pode andar em paralelo com 4, mas não antes de 3, porque missão escolhe conta por provider.

**v0 concluído** em `feat/mission-engine-v0`: Mission persistida em cima de `runs/`, ciclo draft → running → done/failed/cancelled, UI e E2E real. Detalhe e o que ficou fora em [MISSION_ENGINE.md](./MISSION_ENGINE.md).

**Mission Runtime v0.1** em `fix/mission-runtime-v01` (concluído nesta base): launcher Windows sem `cmd.exe` para shims npm, política do lead imposta no broker e na CLI, aprovações na tela da Mission (mesma fila da Fleet), evento `cc-mission-changed`, progresso só de workers e E2E real com lead + 3 workers. Detalhe em [MISSION_RUNTIME.md](./MISSION_RUNTIME.md). Roles + Squads v0 e Handoff Structured v0 também estão concluídos nesta base. Shared Memory v0 está implementada e validada na PR #4, aguardando merge, com gates e E2E concluídos; Map Mode continua pendente.

## 6. Task Engine

Tasks com estado, dependência, retry e roteamento. Grande parte já está em `runs/` (scheduler, DAG, `run plan`, complexidade). O trabalho é alinhar o vocabulário da missão a essas tabelas, não escrever outro supervisor.

Depende de: 5.

## 7. Worktree por missão

**v1 concluído** em `feat/mission-review` (PR #11). Continua havendo um worktree por task isolada. A Mission ganhou um **worktree de integração**, criado na primeira entrega aceita na tela "Revisão das entregas", onde as branches aceitas são unidas sem tocar na cópia de trabalho do usuário. "Aplicar no projeto" faz um único merge da integração. Conflitos são sempre abortados e listados. Detalhes em [MISSION_ENGINE.md](./MISSION_ENGINE.md).

**Etapa 21 concluída:** (a) "Limpar worktrees" no detalhe da missão encerrada (dry-run primeiro; recusa alterações não commitadas ou commits fora do master e mostra o bloqueio; junction de `node_modules` removida antes, pela API do SO); (b) `ags mission cleanup <id> [--dry-run]` e `ags worktrees list|prune` (órfãos, tamanho e o que impede a limpeza); (c) conflitos de integração resolvidos na app, com as duas versões lado a lado e "manter o meu / o do master / os dois" (fusão pura testada; ROADMAP e locales JSON mantêm os dois lados). Código não trivial segue para o agente/usuário. Detalhes em [MISSION_CLEANUP.md](./MISSION_CLEANUP.md).

## 8. MCP interno da ADE

O servidor `ags` em `ipc/mcp.rs` fornece browser, frota, Git, perguntas e permissões. A ADE o entrega por sessão aos providers com mecanismos isolados verificados: Claude Code, Codex, OpenCode, Hermes e Antigravity (temporário por turno nas conversas por protocolo). Codex TUI usa overrides `-c` apenas no processo, sem alterar `CODEX_HOME/config.toml`. Kimi segue disponível como executor headless, mas sua CLI atual não aceita MCP por processo; a ADE não grava nos arquivos globais nem no projeto. O gerenciador para instalar servidores MCP de terceiros e anexá-los a workspaces ou abas continua planejado.

Codex, Claude Code, OpenCode e Antigravity por conversa podem consultar o roster e delegar ao scheduler existente. Gemini CLI ainda não recebe a integração de orquestração por sessão.

## 9. Event Bus

**v1 concluído** em `src-tauri/src/bus.rs`.

- **Formato:** todo evento da frota e das missões passa por um único bus, com `seq` crescente, ids de task/run/mission e os últimos 2000 eventos em memória.
- **Tópicos:** `task.changed`, `task.activity`, `task.rerouted`, `account.failure`, `approvals.changed` e `mission.changed`.
- **Leitura:**
  - `since(after)` atualiza quem chega tarde e marca `truncated` se algo já saiu do buffer.
  - `wait` bloqueia até chegar algo novo.
  - A UI recebe tudo pelo único evento Tauri `ade-event`.
  - A CLI usa `ags events since|wait`, com filtros de tópico, run, missão e task.

Os canais antigos (`cc-task-*`, `cc-mission-changed`) continuam funcionando, então as telas existentes não mudaram.

Pendente: migrar as telas para o bus e incluir o watch/cursor das tabs interativas.

## 10. Handoff estruturado

**Handoff Structured v0 = concluído.** A migration v22 adiciona `structured_handoff` e preserva `handoff` legado. Dependências diretas concluídas do mesmo Run recebem as entregas em ordem determinística, como dados delimitados e não confiáveis, com validação e limites de payload. Mission e Fleet usam o mesmo componente de visualização. Retry de Mission preserva Runs anteriores, e as entregas persistem após restart. Detalhes em [HANDOFF_STRUCTURED.md](./HANDOFF_STRUCTURED.md).

Usa o scheduler e MCP existentes; não depende de um Event Bus unificado novo.

## 11. Roles

**v0 concluído.** Roles + Squads v0 implementa oito functional roles built-in, declarativas em código, separadas de execution role (`lead | worker`). `Task.functional_role` registra a especialidade; provider/model/account são resolvidos pelo Squad e snapshotados no Run e na Task. Detalhes em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

Custom Roles e permissões universais por Role continuam fora do v0.

## 12. Squads

**v0 concluído.** Roles + Squads v0 implementa Squad persistente com Lead próprio e members que mapeiam uma Role funcional para provider/model/account. A Mission draft pode escolher Automatic, Specific provider ou Squad. O Run congela a configuração; editar o Squad afeta apenas novos Runs. Não é uma frota paralela e reutiliza o router existente.

Não inclui fallback silencioso, troca automática de modelo, scoring ou marketplace. Retry de Mission failed já está implementado, preservando os Runs anteriores.

## 13. Shared Memory

**Shared Memory v0: mergeada no master (PR #4), com gates e E2E real concluídos em 01/10/2026. Etapa 23: higiene de memória, repositório Markdown local e Dreaming v0 (só propõe), documentados em `MEMORY_REPO.md`.**

`run_facts` continua sendo colaboração append-only de um Run. Shared Memory v0 adiciona Workspace Memory e Mission Memory em SQLite local, com propostas e aprovação explícita do usuário. Cada Run congela um snapshot das memórias aprovadas no início; workers e Lead recebem esse snapshot como dado não confiável. Detalhes e limites em [SHARED_MEMORY.md](./SHARED_MEMORY.md).

O E2E confirmou retry com snapshot atualizado, histórico antigo preservado, Lead e worker Codex, publicação de Fact e handoff, proposta de memória aprovada pelo usuário e persistência após restart. Banco original restaurado e evidências preservadas fora do repositório. O Event Bus unificado e Map Mode continuam etapas separadas.

## 14. Usage, custos e limites (parcial)

Claude já expõe plano e tokens. A frota já tem `budget_usd` e soma tokens quando o stream traz. **Etapa 21 implementada:** guarda de orçamento puro (ok / aviso ≥80% / estourado ≥100%, só tokens medidos, modelos sem preço sinalizados) com barra no QG e na aba da missão, aviso `[AGS] orçamento a 80%...` na orquestradora e em `ags mission efficiency`; ao estourar, `ags peer recruit` e novas tarefas pedem confirmação (elevar o teto ou continuar, registrado), sem derrubar agentes em andamento. Uso uniforme: Codex e OpenCode (SQLite somente leitura) medidos; Gemini, Antigravity e limite de plano do Claude aparecem como "não medido" por falta de fonte legível. Detalhes em [MISSION_TOKENS.md](./MISSION_TOKENS.md).

Pendente: tokens de Gemini/Antigravity e janela de limite do Claude quando as CLIs expuserem arquivos legíveis.

Depende de: 2 e 6. Usage e custo dependem dos dados reportados pelo adapter: tokens já aparecem para Codex, mas custo por worker não tem cobertura uniforme. Não bloqueia 4.

## 15. Map mode

**v1 concluído** (`MissionMap.tsx`, no detalhe da Mission). O mapa mostra:

- o Lead no topo e as tasks em camadas, conforme as dependências;
- arestas de dependência, e arestas tracejadas do Lead para tasks sem dependência;
- borda e ponto coloridos pelo status;
- agente, modelo e conta em cada task;
- o marcador ↻ em tasks que trocaram de mãos.

A ferramenta que cada agente está usando agora vem ao vivo de `task.activity` no bus. Não é um runtime novo: lê as tasks do detalhe e o bus.

**Etapa 21 concluída:** zoom (roda e botões), pan por arrastar e "ajustar a tela" no mapa (reaproveita `viewport.ts`), e a visão **Frota** com tasks/terminais ativos de todas as missões em andamento, agrupados por missão, com os mesmos sinais do indicador das abas e do Ao vivo.

Depende de: 9, 10, 12 e 13. É a última porque desenhar cedo fixa um modelo que essas etapas ainda vão mover.

## Ao vivo no BotPanel

**v0 implementado em feat/etapa9-ao-vivo:** quinta aba com arcade de uma missão, andares derivados de tarefas, tempos e revisões, dependências reais, sprites ligados à atividade sustentada e placar que marca dados ausentes como não medidos. O canvas pausa quando oculto, respeita movimento reduzido e não emite áudio. Escopo e fontes em [LIVE_ARCADE.md](./LIVE_ARCADE.md).

**v1 implementado:** barris só com obstáculos medidos (aprovação pendente, falha/teste, memória sem resposta, peer ask expirado) e troféu de integração; PR/CI seguem "não medido".

**v2 implementado:** visão unificada (um fliperama por missão em execução) com seletor TODAS | missão. Pendente futuro: persistir `peer ask` em aberto para virar barril ao vivo.

**v3 (Etapa 12) implementado em feat/etapa12-v3-*:** um herói por terminal (sprite por plataforma, cor por papel) que anda de verdade pelas vigas e sobe escadas até o andar da etapa; a fase vira construir a torre (um bloco por tarefa concluída, PR/CI em cinza "não medido"); barris rolam pelas vigas e travam o herói afetado. Detalhes em [LIVE_ARCADE.md](./LIVE_ARCADE.md).

## Etapa 10 — entrega em terminais (ponto 5)

**Implementado:** finalizar uma missão em terminais registra o resultado dos testes informado pelo usuário e, se houver PR, consulta os checks com `gh` em modo somente leitura. Só testes aprovados com CI verde (ou sem PR) recebem `done`; os outros casos ficam separados como `done_without_delivery`. A migration v27 preserva todos os estados históricos. Detalhes em [MISSION_DELIVERY.md](./MISSION_DELIVERY.md).

## 16. Grade de recruits no canvas

**Ponto 1 concluído.** Recruits adicionados por `ags peer recruit` seguem as duas linhas da grade da missão e ocupam a próxima célula livre sem mover panes existentes. Detalhes em [RECRUIT_GRID.md](./RECRUIT_GRID.md).

## 17. Taxa de sucesso das missões (Etapa 10)

Etapa voltada a prevenir e classificar falhas de ambiente e duplicatas históricas:
- **Ponto 4 (Evitar missão duplicada):** implementado em `feat/etapa10-p4-duplicada`. Detecção de duplicatas com mesmo título e objetivo normalizados, em andamento (`running`) ou recente (24h). Bloqueio preventivo no backend (`start_now` / `start` salvo com flag `--force`) e aviso na interface (`DuplicateMissionDialog` em `MissionsPage` e `MissionsSection`, alerta em `MissionDialog`). Detalhes em [MISSION_SUCCESS.md](./MISSION_SUCCESS.md).

## Estado Antigravity

A integração nativa oferece Lead e Worker, model discovery via `agy models` e uma conta do sistema. Multi-account permanece experimental/incompleto: `supports_accounts = false`, sem routing simultâneo por conta. OAuth experimental não isola as credenciais do `agy`. Veja [ANTIGRAVITY_INTEGRATION.md](./ANTIGRAVITY_INTEGRATION.md).

## 10. Taxa de sucesso das missões

Ponto 1: precheck de instalação, sessão, catálogo por conta e limite antes do lançamento. Ver [MISSION_SUCCESS.md](./MISSION_SUCCESS.md).

Ponto 1, revisão QA: aviso de erro traduzido na lista de missões e bloqueio preventivo quando a conta principal não está exposta no roster.
Ponto 2: failover opcional por autenticação, modelo ou saldo no mesmo pool/TUI, com uma troca por task, cooldown e auditoria traduzida. Ver [MISSION_SUCCESS.md](./MISSION_SUCCESS.md) e [POOL_FAILOVER.md](./POOL_FAILOVER.md). O mesmo pool agora vale para conversas do modo chat por protocolo (desligado por padrão; `avisar e perguntar` ou `automático`).

## 17. Classificação de falhas (Etapa 10, ponto 3)

**Implementado:** classificação tipada e persistida no fechamento (`failureClassification` + `failureDetail`), exposta por `mission_list`, `mission_get` e pelos resumos da CLI. O Frontend mostra causa e ação no QG e no detalhe da missão. Ver [MISSION_FAILURES.md](./MISSION_FAILURES.md).

## 17. Taxa de sucesso das missões (Etapa 10)

**Ponto 6 (medição) implementado no front:** cartão com histórico, 7 e 30 dias, canceladas à parte e missões de teste/E2E por marcação explícita (`isTest`). Pendente: backend gravar `isTest`. Detalhes em [MISSION_SUCCESS.md](./MISSION_SUCCESS.md).

Ponto 6, backend: marcação explícita `isTest` na criação/início (CLI `--test`), persistida no schema v27 e exposta em lista/detalhe/status, sem inferência por título. Migração preserva status e classifica legadas como reais.

## Etapa 11 — eficiência entre agentes, ponto 1 (agente parado)

**Implementado:** detector de "recebeu tarefa e ficou quieto". O backend emite `cc-peer-message` em cada `peer tell`/`peer ask`; o watcher abre uma tarefa pendente quando o orquestrador faz `tell` a um membro e a fecha quando o membro manda qualquer mensagem. Passado o plazo sem saída (120 s), o orquestrador recebe um aviso com nome, tempo parado e última linha da tela. Sem aviso se o agente escreve (pensando), se há diálogo de aprovação na tela ou se o usuário digitou na aba. Ver [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 11 — eficiência entre agentes, ponto 2 (peer ask)

**Implementado:** prazo inclui preparação/envio; `peer check` consulta status e resposta parcial da última pergunta sem repetir o pedido. `mission timings` apresenta ranking de gargalos por agente a partir de `peer_ask` e `turn`. Turnos após o briefing também são registrados, com dono único e preservação de `detail: "briefing"`. Eventos de comunicação do ponto 1 são reutilizados por destino, inclusive em batch/recruit. Detalhes e limites de inferência em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 11 — Eficiência entre agentes

**Ponto 3 implementado:** ao criar o worktree, a app prepara a junction de `node_modules` no Windows ou symlink em Unix, sem substituir diretórios existentes; falhas geram aviso sem bloquear o recruit. O briefing inicial inclui caminho, shell e comandos de validação, com `cargo test --lib` filtrado. O target Cargo compartilhado é configurável como `per-worktree` para evitar disputa de lock entre agentes simultâneos, com o custo de recompilar dependências uma vez por worktree. O procedimento multiplataforma está em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 11 — eficiência entre agentes (P4)

**Ponto 4 implementado:** o QG e o painel da missão mostram tempo ativo sem sobreposição, tempo de relógio, custo reportado pelos Runs, agentes observados e comparação com até 30 missões concluídas do workspace, agrupadas por faixa de agentes. O briefing só recomenda recrutar quando o trabalho é independente e paralelizável e há expectativa de terminar mais rápido do que com um agente só. Métricas, limites e API estão em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md); a linha de base anterior do QA está em [AGENT_EFFICIENCY_BASELINE.md](./AGENT_EFFICIENCY_BASELINE.md).

## Etapa 11 — eficiência entre agentes (ponto 5)

**Menos conversa, mais memória:** o briefing consulta os registros existentes antes de perguntar; integrantes enviam uma única entrega final com resultado, decisões, arquivos, testes e bloqueios. Handoff Structured permanece como registro de entrega entre Tasks do Mission Runtime; Shared Memory guarda somente conhecimento aprovado e duradouro. Detalhes e comparação estática de tokens em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 13 — Squad: subagente padrão e modo Fast (ponto 1: Fast)

Implementado em `feat/etapa13-1-fast`: schema v30 (`fast_mode` em `squads`/`squad_members`), interruptor "Modo Fast" só para Codex na tela de Squad (pt-BR/en/es), `withModel`/`recruitCommand` com `-c service_tier=fast` e `ags peer recruit --fast`. Detalhes em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

### Etapa 13 — ponto 2 (subagente padrão do Squad)

Implementado em `feat/etapa13-2-subagente` (empilhada em `feat/etapa13-1-fast`): schema v31 (`subagent_*` em `squads`), campo `defaultSubagent` no Squad (Automático ou agente + modelo + esforço + Fast), seção na tela de Squad (pt-BR/en/es), validação e testes. O uso no `ags peer recruit` e no briefing vem no ponto 3.

### Etapa 13 — ponto 3 (uso no recruit e no briefing)

Implementado em `feat/etapa13-3-recruit-padrao` (empilhada nas anteriores): `ags peer recruit` sem `--model`/`--effort` usa o subagente padrão do Squad da missão em execução (explícitos vencem; Automático/sem Squad = comportamento atual), briefing do orquestrador mostra o padrão ativo ou manda justificar a escolha, skill `ags-orchestrator` 1.26.0 e help da CLI atualizados. Detalhes em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

## Etapa 14 — unificar o tempo ativo

Fonte única em `missions/active.rs`: `mission_active` positivo → união de spans `turn`/`peer_ask` → relógio de parede com `started_at` → não medido. Lista, QG, painel de tempos, `ags mission efficiency`/`timings` e medianas históricas por faixa de agentes usam a mesma duração e identificam sua fonte. Spans permanecem como detalhe por turno (`turnMs`) e gargalos. Sem migração nem alteração de dados antigos.

A fotografia somente leitura do banco real mostrou cobertura de 9/47 missões em `mission_active` e 20/47 em spans; na missão `f754b31f`, 4.322 s contra 28 s. Semântica, limitações, comparação e contratos em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md); integração com a seção Tempos em [MISSION_TOKENS.md](./MISSION_TOKENS.md#tempo-ativo-da-missão). A validação inclui escolha de fonte/fallback e consistência entre lista, eficiência e tempos nos três caminhos.

## Etapa 15 — Início rápido, Ao vivo que funciona e abas

Cinco pontos de melhoria estrutural focados na velocidade de inicialização das equipes, segurança operacional e visibilidade em tempo real.

### Ponto 1 — Início rápido da missão
- **Problema:** O boot de terminais levava de 5 a 11 s, mas o primeiro turno dos agentes demorava de 7 a 13 minutos (Etapa 14: Frontend 488 s, Orquestrador 421 s, QA 800 s; primeiro peer ask do orquestrador apenas aos 701 s, que expirou). O atraso vinha do orquestrador explorando código antes de delegar, membros explorando/editando por conta própria antes de receberem tarefas e múltiplos agentes dividindo o mesmo worktree concorrentemente ("Backend já está editando o Rust neste worktree").
- **Implementado:**
  1. Métrica "tempo até a primeira delegação" (`spans`/`peer_message`) visível no QG do bot e na CLI `ags mission timings`.
  2. Protocolo de briefing estruturado: orquestrador elabora plano conciso e delega a cada integrante em até ~2 minutos antes de realizar exploração profunda; briefing dos integrantes proíbe exploração ou edição prévia à tarefa.
  3. Worktree e branch dedicados por integrante no início da missão, reaproveitando a infraestrutura de `floors.rs`/setup da Etapa 11 (junction de `node_modules` no Windows e `CARGO_TARGET_DIR` isolado `per-worktree` para evitar disputa de lock do Rust). O briefing informa o caminho exato e a branch do integrante.
  4. Pré-preenchimento no briefing com as informações apuradas pelo precheck e pela Shared Memory, eliminando buscas redundantes. Redução medida do primeiro turno de 7-13 min para ~2 min.
- Detalhes e contratos em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

### Ponto 2 — 'X' nas abas de missão
- **Implementado:** Botão de fechamento ('X') integrado diretamente nos chips/abas de missão no topo da interface (`MissionChips.tsx`).
- **Segurança operacional:** Fechamento com verificação de estado (`closeMissionNeedsConfirm` em `groups.ts`). Missões em andamento (`running`) exibem diálogo de confirmação com aviso de encerramento de processos/terminais dos agentes (`missions.chips.closeTitle`, `missions.chips.closeBody`). Missões já concluídas, canceladas ou sem processo ativo fecham imediatamente sem diálogo redundante.
- Suporte a i18n completo (pt-BR, en, es).

### Ponto 3 — Ao vivo que funciona para missões em terminais
- **Problema:** No arcade do QG do bot (`LiveArcade`), heróis ficavam estáticos na viga inferior ("equipe") porque missões em terminais não utilizam tarefas clássicas de DAG/Run. O HUD de "Tempo ativo" exibia "não medido" mesmo com a missão em execução.
- **Implementado:**
  1. Derivação de andares e estados através de sinais reais de terminais e papéis: Abertura (briefing/aguardando), Trabalho (saída sustentada em terminal), Testes (papel QA/testes), Revisão (papel revisor) e Entrega (conclusão).
  2. Animação e movimentação física: heróis andam pelas vigas e sobem/descem escadas reais nas mudanças de andar; patrulham durante saída sustentada, dormem (`Z`) quando inativos e assumem alerta (`!`) em bloqueios ou esperas.
  3. Blocos da torre erguidos na entrega final de cada integrante (`peer tell` padronizado de encerramento).
  4. Barris estritamente atrelados a fontes reais (aprovação pendente, checks falhando, memórias pendentes, peer ask expirado).
  5. HUD "Tempo ativo" alimentado pela fonte unificada da Etapa 14 (`activeSeconds` e `activeSource`), refletindo tempo ativo real sem exibir "não medido" em missões ativas; sem dados disponíveis permanece cinza.
- Detalhes visuais e contratos em [LIVE_ARCADE.md](./LIVE_ARCADE.md).

### Ponto 4 — Logos em pixel art na legenda
- **Implementado:** Substituição do antigo marcador quadrado por ícones pixel-art 12x12 de cada plataforma (Claude, Codex, Antigravity, Gemini, OpenCode e genérico) ao lado do status do agente na legenda do Ao Vivo.
- Desenhados programmaticamente via Canvas/CSS sem uso de imagens externas ou assets adicionais.

### Ponto 5 — Modo abas com panes lado a lado em grade
- **Implementado:** Na visualização de abas da missão (ao lado de Canvas), opção para dispor todos os panes lado a lado em grade.
- Configuração individual por missão/aba, persistida localmente (não global), mantendo a visualização tradicional empilhada/tabulada como padrão.
- i18n completo (pt-BR, en, es) e testes dedicados.

## Etapa 15 — abas de missão, Ao vivo e grade (Frontend)

- [x] X nas abas de missão do topo, com confirmação se a missão está em andamento.
- [x] Ao vivo derivado dos sinais dos terminais (andar, escadas, patrulha, `!`, bloco por entrega final), HUD com a fonte unificada.
- [x] Logos pixel-art 12x12 na legenda.
- [x] Modo grade (todos os panes lado a lado), individual por missão e persistido.


## Etapa 16 — orquestração confiável

- [x] Detector de **orquestrador parado** (`missions/leadStall.ts`): integrante pediu algo (`peer ask`, `peer tell` com `?`, ou pergunta na tela) e o orquestrador não respondeu em 3 min (`LEAD_STALL_MS`, configurável em `localStorage["ags.leadStallMs"]`, mínimo 30 s). Aviso no terminal do orquestrador (`pasteIntoTab`), alerta no QG e na aba da missão, span `orchestrator_stall`.
- [x] **Teste de início de missão**: eventos `start_briefing`, `start_activity`, `start_retry`, `start_stalled` e `start_all_working` (tempo até todos trabalhando, exibido no QG) gravados em timings; verificação de 2 min (`START_DEADLINE_MS`).
- [x] `ags mission timings` e `ags mission startcheck <id>` (Backend).

## Etapa 16 — métricas e verificação do início (Backend)

`ags mission startcheck <id>` consulta briefing, atividade, retries e avisos por integrante, incluindo quem nunca iniciou, e verifica o limite de 120 segundos desde a abertura dos terminais. `ags mission timings` expõe contagem de alertas, espera total/máxima do orquestrador e tempo até todos trabalhando. Reutiliza `mission_timings` e a equipe persistida; nenhuma migração necessária. A instrumentação de atividade, retry e alertas fica no frontend; o comando não envia Enter nem altera terminais. Contrato em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md).

## Etapa 18 — Canvas de Design: pranchetas, comentários e aprovação

- [x] **Backend**: designs, páginas, pranchetas (HTML, tamanho, posição, versão, status), histórico de versões e comentários, em tabelas aditivas e idempotentes; comandos IPC `design_*`, evento `design-changed` e CLI `ags design`. Detalhes em [DESIGN_CANVAS.md](./DESIGN_CANVAS.md).
- [x] **Frontend**: painel Design no canvas (zoom/pan, páginas, iframe em sandbox, modo EDIT, comentários por elemento, versões, aprovar/rejeitar/aprovar tudo, atualização ao vivo).
- [x] **Fluxo de construção**: só pranchetas aprovadas viram tarefas (`buildTasks.ts`); briefing do orquestrador e skill `ags-orchestrator` 1.27.0 com "desenhe primeiro, aprove, construa".
- [ ] Fora do escopo (etapa seguinte): preview real do app em dev server por worktree; compartilhar link.

## Etapa 19 — Design no canvas principal e acabamento (Backend)

- [x] Posicionamento automático de pranchetas novas; arraste preserva aprovação/versão e desfazer preserva posição.
- [x] Dedupe de designs por missão/título, consolidação sem perder propostas existentes (v37), aliases dos IDs antigos, arquivar e excluir via Tauri/CLI.
- [x] Dono pela aba criadora (`from`/`ADE_TAB_ID`); evento distingue design novo de reuso.
- [x] Identidade do build em `ags --version` e comparação do CLI adjacente com a app, com limite de tempo e testes.

## Etapa 19 — Design no canvas principal e acabamento

- [x] **Design no canvas principal (Frontend)**: pranchetas dispostas diretamente como nós do canvas com molduras agrupadas por página/design (`layoutGroups`), origem livre à direita (`freeOrigin`), foco automático e enquadramento (`fitViewport`).
- [x] **Aviso de novo design e foco (Frontend)**: detecção de designs recentes não vistos (`freshDesigns`), exibindo toast interativo com ação rápida de "Abrir" para focar imediatamente o nó criado pelo agente.
- [x] **Dedupe, Delete e Archive (Backend/Frontend)**: migração v37 consolidando designs duplicados e adicionando índices únicos (`mission_id, title` e `workspace, title`) com preservação de páginas, comentários, versões e mapeamento de aliases legados; comandos e UI para exclusão total (`design_delete`) e arquivamento (`design_archive`).
- [x] **Posicionamento e arraste (Backend/Frontend)**: pranchetas em (0,0) espalhadas automaticamente (`spreadOverlapping`); arraste de prancheta separa movimento (x, y) de edição de conteúdo, preservando aprovação e versão sem inflar histórico de snapshots (`positionsToSave`).
- [x] **Resolução de dono e resiliência (Backend/Frontend)**: criador identificado por `from`/`ADE_TAB_ID`, fallback para orquestrador da missão quando a aba for fechada, e badge informativo com tratamento gracioso de ações quando sem dono ativo.
- [x] **Detecção de CLI desatualizado (Backend/Frontend)**: checagem de build/hash entre app e binário adjacente (`cli_build_status`) e alerta proativo único por sessão (`useCliOutdatedNotice`).
- [x] **Auditoria e Regressão (QA)**: auditoria com dados reais do SQLite (`~/.ags/data.db`: design "Polir o bot - aura e acabamento" duplicado e 5 pranchetas sobrepostas em x=0, y=0), relato de defeitos reprodutíveis aos pares via `ags peer tell`, revisão analítica dos recursos de edição/comentários/desfazer/aprovação, testes de integração/regressão (`designCanvasIntegration.test.ts`) e documentação em [DESIGN_CANVAS.md](./DESIGN_CANVAS.md).

## Etapa 17 — custo, Fast headless, entregas e memória
- Custo por aba (tokens/custo por terminal da missão): ver MISSION_TOKENS.md.
- Fast nas execuções headless: ver AGENT_EFFICIENCY.md.
- Reavaliação de missões `done_without_delivery` (`ags mission redeliver`): ver MISSION_SUCCESS.md.
- Revisão das memórias sugeridas ao concluir a missão (duplicadas, contradições, alto valor): ver SHARED_MEMORY.md.

## Etapa 17 - uso por aba (Backend)

Implementado em `feat/etapa17-tab-usage`: `mission_tokens` inclui `agents[].tabs`, e `ags mission efficiency` inclui `tokens`. Soma das abas = total do agente; soma dos agentes = total da missao. Identidade persistida, sessao antes de cwd exclusivo, deltas Codex e nenhuma medicao inventada. Contrato e limitacoes: [TAB_USAGE.md](./TAB_USAGE.md).

## Etapa 17 - Fast headless (Backend)

Implementado em `feat/etapa17-headless-fast`: snapshot Fast do lead e dos integrantes persistido em runs/run_squad_members (v34); supervisor passa `LaunchCtx.fast_mode` e Codex usa `-c service_tier="fast"`. Providers sem equivalente nao recebem flags. Formatos CLI verificados, limites e testes: [FAST_HEADLESS.md](./FAST_HEADLESS.md).

- Etapa 20 (UI): ver [ETAPA_20_POLIMENTO_UI.md](ETAPA_20_POLIMENTO_UI.md) — chat (Markdown, tamanho, trazer do terminal), navegador no Canvas, scrollbars, modal único de memória.

## Etapa 22 — velocidade de teste

Redução drástica do tempo de feedback de testes para agentes e humanos através de execução seletiva de testes afetados, compartilhamento de cache de compilação Cargo entre worktrees, cache persistente de resultados em banco de dados SQLite e fluxo de validação contínua pelo QA.

- **Ponto 1 (Medições e Baseline):** Levantamento empírico documentado em [TEST_SPEED.md](./TEST_SPEED.md) (tsc 15s, vitest 14s, vitest --changed 4s, babel 1s, CI 3-4min, cargo cold 204,63s, cargo warm 14,55s, warm unchanged 1,08s).
- **Ponto 2 (Cargo Target Compartilhado):** Worktrees de missão configurados com `ADE_AGS_CARGO_TARGET_DIR` apontando para `~/.ags/cargo-target-agents`, eliminando compilações frias redundantes de 519 crates e reduzindo rebuilds para 1s–14s; contenção concorrente segura (15,9s–16,4s em 4 jobs simultâneos).
- **Ponto 3 (Regras de Execução e CI):** Agentes proibidos de executar suíte completa local de forma recorrente; acompanhamento de PR exclusivamente via `gh pr checks <n> --watch` (sem polling com sleep); suíte completa local restrita a operações de alto risco (migrações de banco, `unsafe`/COM e alterações de schema).
- **Ponto 4 (Testes Afetados e Cache de Resultados):** Comandos `ags test affected` e `ags test run <suite>`, mapeando arquivos modificados desde `origin/master` e gravando execuções verdes limpas na tabela `test_results` para retorno instantâneo (0ms em cache hit).
- **Ponto 5 (QA em Fluxo):** Briefing atualizado para validação contínua a cada entrega de integrante (`ags peer tell`) com `ags test affected`; orquestrador notifica o QA a cada entrega; validação final consolidada em UMA única execução completa antes da entrega (ou delegação ao CI); métrica "tempo de espera do QA" (`qaWaitMs`) exposta em `ags mission timings`.

## Simulador iOS no canvas

iPhones e iPads do Xcode ligados sem o app Simulator, soltos no canvas com a barra flutuante e a conversa com os agentes conectados. A tela é a `IOSurface` do simulador numa camada nativa, sem cópia; o toque vai pelo HID do SimulatorKit; os agentes pilotam com `ags device …`. No modo leve, o iOS sobe sem os serviços pesados (Siri, widgets, iCloud, Spotlight…): medido no iPhone 17, de 495% para 1% de CPU depois do boot. Os quadros chegam numa fila própria, fora da thread da interface. Como funciona, leveza e o que falta: [SIMULADOR_IOS.md](./SIMULADOR_IOS.md).

A prioridade de segundo plano só entra fora de vista e 60 s após a última ação de agente; a ação restaura a prioridade normal sem esperar o monitor. O painel consulta o app aberto ao montar, trocar aparelho, reabrir o app e recuperar foco, sem intervalo. O executável responde a `--version`/`--help` antes de iniciar Tauri e preserva o handshake global de uma instância viva; cada instância publica também seu handshake próprio. Após um restart, a manutenção assume o global quando a instância antiga sai. Testes isolados usam outro `ADE_AGS_DATA_DIR`.

## Portal com Chrome real

O Portal pode mostrar um Chrome de verdade (perfil próprio do app), todo dentro do app: tela por screencast, login do Google numa janela de Chrome comum encaixada sobre o Portal, uma janela por Portal, zoom, barra de rolagem sobreposta, e o Jev pilotando com cliques e teclas de verdade (`isTrusted`). Desenho, decisões (sem esconder a automação) e limites: [PORTAL_CHROME_REAL.md](./PORTAL_CHROME_REAL.md).

## Testes por replay das telas dos agentes

Fixtures com a saída crua do PTY (pedaços com o instante em que chegaram) passam pelos detectores de verdade, no front (xterm real, relógio falso) e no backend (fim cru do PTY), sem app nem PTY. Gravador só para desenvolvimento (`ags replay start/stop`, com `ADE_AGS_REPLAY_RECORD=1`). Formato, gravador, fixtures e o que já acharam: [REPLAY_TESTES.md](./REPLAY_TESTES.md).

## Bancada dos motores por protocolo

Fake de agente com falhas roteirizadas (stall, JSON cortado, queda, cota, `max_tokens`, aprovação, pergunta, modo aleatório com semente) tocado nos mapeadores reais de `claude -p`, `codex app-server` e ACP; replay de transcript de protocolo (`ade-replay` v2) com placeholders tipados, modos `replay`/`refresh`/`record`, oráculo que o refresh não reescreve e guard de ferramenta desconhecida; mock de `invoke` por nome com `assertNoUnmatched()` no front. Usado nos testes de `resume.rs` e do pool de contas. Achou: a queda do Codex sem motivo, o Codex que esgota sem acionar o pool e o `max_tokens` do Claude que acaba como "ok". Uso e limites: [BANCADA_MOTORES.md](./BANCADA_MOTORES.md).

## Pontos de restauração das abas

A cada mensagem que chega a um agente numa aba (peers, `ags tab send`, chat, rotinas, missões e o Enter no terminal), uma foto dos arquivos da pasta vai para uma ref git escondida (`refs/ags/checkpoints/<aba>/<n>`), sem tocar branch, índice nem stash. No menu da aba: "Pontos de restauração…" (ver o diff desde um ponto, voltar os arquivos até ele com ponto de segurança e trava de pasta compartilhada) e "Marcar ponto". A conversa do agente não volta. Desenho e limites: [CHECKPOINTS_ABAS.md](./CHECKPOINTS_ABAS.md).

## Comparar modelos

O mesmo pedido para 2 a 6 agentes/modelos, cada um num worktree e numa branch `cmp/<slug>-<id>/<pick>`, em terminais lado a lado num canvas próprio, com barra de status, diff por modelo, "Manter este" e descarte que nunca perde trabalho sem confirmação (o descartado fica em `refs/ags/descartes/`). Detalhes em [COMPARAR_MODELOS.md](./COMPARAR_MODELOS.md).

## Integração de recursos do T3 Code

- **Seletor de agente/modelo:** o popover usa um portal ancorado à posição do botão, escolhe acima/abaixo conforme o espaço disponível e recalcula posição e altura ao rolar ou redimensionar a janela. O cálculo usa o viewport de layout do WebView, com limites explícitos no topo, na lateral e na altura; se o espaço junto ao botão for pequeno, o painel usa a janela e se centraliza para conservar o rodapé. O conteúdo interno encolhe e rola sem empurrar controles para fora. Ver [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Atalhos contextuais do Chat:** `sidebar.toggle`, `modelPicker.toggle` e `diff.toggle` estão disponíveis na paleta e no catálogo editável, sem combinação padrão. O seletor de agente só atua no composer visível da conversa atual; Diff alterna a superfície sem afetar o estado das demais; a sidebar só alterna no Chat e fora das rotas de tela cheia.
- **Comandos do Browser:** ações de prévia só usam a instância visível; atalhos não capturam campos editáveis e o toggle não disputa teclas quando a própria prévia está focada. A comparação e as limitações estão em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#auditoria-do-cat%C3%A1logo-de-atalhos-do-t3).
- **Delegação entre sessões conectadas:** `team_candidates` lista sessões abertas elegíveis ao orquestrador; `team_link` revalida vínculo e escopo, e `peer_ask`/`peer_tell` delegam a integrantes sem iniciar um worker headless. A Frota continua sendo o caminho para tarefas isoladas em worktree e com orçamento. Veja [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#delegação-entre-sessões-conectadas).
- **Harness multiruntime (em andamento):** além do contrato `EngineCapabilities` para conversas por protocolo, runs de subagentes iniciados por um chat persistem a conversa de origem; `task_add` usa esse escopo e o chat mostra lineage por eventos. `delegate_task` cria uma tarefa filha única, assíncrona ou com espera, permite selecionar agente/modelo do roster e grava `client_request_id` junto ao run/tarefa para impedir duplicação em retry. `chat_new` cria threads nativas filhas; o Vigia avisa o pai dos bloqueios/destravamentos pelo `parent_ref`, e o feed reúne essas threads com as tarefas da Frota, sem assumir aprovações humanas. Tasks headless da Frota e threads nativas já aparecem numa projeção comum, e eventos semânticos persistem a relação com threads, turnos e tentativas; o estado de execução ainda pertence às tabelas nativas. Ainda faltam estado durável comum de `ExecutionNode`, reconciliação após reinício, adapters com capacidades verificáveis de retomada/eventos/permissões, handoff assíncrono durável de resultado e cancelamento descendente. O levantamento e as lacunas estão em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#harness-multiruntime-arquitetura-e-paridade-alvo). Os documentos V2 do T3 são referência de arquitetura-alvo, não promessa de que todos os detalhes já estão no produto. O contrato da Fase 0 (matriz capability × provider/superfície, identidade, estados, migração aditiva, provas de replay e a fatia da Fase 1) está em [HARNESS_CONTRATO.md](./HARNESS_CONTRATO.md); o backend consulta a matriz, o Tauri expõe a matriz inteira e `ags chat providers` inclui a linha do harness por provider. O seletor de agente e o composer estruturado aplicam `Unsupported`; concluir a migração segue pendente, incluindo a divergência registrada no contrato e capacidades que ainda não têm célula. **Fase 1 (feita no backend, sem prova visual):** `harness_run` e `harness_node` nascem no primeiro filho de um turno (conversa filha ou delegação à Frota), na mesma transação da criação; o estado continua derivado do nativo; `run_list_harness_graph` devolve `nodeId`, `harnessRunId` e `chatRunId` e mostra o run da Frota sob o turno que o criou. A UI ainda não foi conferida (teste 10 de §7.4).

- **Delegação unificada do harness:** `delegate_agent` deixa o orquestrador escolher numa chamada entre conversa nativa (`chat_providers`) e tarefa headless (`agent_roster`), com `client_request_id`, contexto explícito e retorno síncrono ou assíncrono. `harness_graph` permite ao agente ler a árvore atual vinculada à própria conversa, incluindo eventos recentes. Desde a Fase 4 a escolha é explícita (`target`: `provider_chat`, `fleet_task` ou `connected_session`, esta última para sessões já conectadas, com revalidação e recibo; contrato §12 do harness). Em `mode=async`, o resultado do filho chega ao pai pela fila durável, como aviso não confiável e limitado, uma única vez mesmo com o app fechado no meio, e a sessão conectada aparece na árvore do painel (contrato §12.9; sem prova visual nem teste de ponta a ponta com agente real). A recuperação e o grafo durável comum seguem pendentes. Veja [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#seleção-unificada-de-agente-filho).
- **Recibos e falhas de gravação do harness (Fase 2, segunda fatia):** o Parar (`chat_interrupt`) aceita `client_request_id` na tela, na CLI e no MCP, com recibo e efeito: repetir o id não manda outra interrupção, e um Parar depois do fim do turno devolve `no_turn` sem efeito. Uma falha de gravação do log de execução deixa de ir só ao `stderr`: fica em `harness_log_failure`, sai como `cc-harness-log-failed` e `harness.log_failed`, e a fase, o pedido e o fechamento só saem depois da tentativa (`chat.changed` com `logged`). Sem tela do aviso ainda, sem prova visual e com `event_sequence`/`causation_event_id` pendentes. Contrato em [HARNESS_CONTRATO.md](./HARNESS_CONTRATO.md) (§11.11).
- **Pedidos privados de segredo:** cartão de senha fora do transcript; valor no Keychain/Secret Service por até 24 h e restrito à conversa. `secret_run`/`ags secret run` o envia somente ao stdin de um executável aprovado, com stdout/stderr descartados; `secret_revoke` antecipa a remoção. Tasks headless não recebem esse recurso. Veja a comparação e os limites em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).

Integração por etapas da interface e dos fluxos de agente do T3 Code, mantendo a arquitetura local-first da ADE. O seletor do chat reúne agente/modelo, esforço, permissão, conta e Standard/Fast, em painel amplo com trilho de agentes e catálogo pesquisável. Novas conversas podem salvar padrões locais e até 32 ações por pasta; nomes e opções ficam no armazenamento local e os comandos no chaveiro do sistema. Ações importadas de `t3.json` são revisáveis e só rodam em PTYs novos quando a pessoa clica. Projetos agora podem ser fixados, arquivados e personalizados com ícone local; arquivar só os remove do seletor de novas conversas, sem encerrar agentes nem ocultar seus chats. O modo de workspace respeita a hierarquia da ADE, preferência da máquina, `defaultThreadEnvMode` do `t3.json` e fallback. Padrões de agente, modelo, esforço, acesso, Plano, Fast, interface e worktree podem ser fixados por campo no projeto ou herdados da máquina; snapshots antigos continuam válidos até serem redefinidos. A inicialização de submódulos em novos worktrees aceita `none`, `top-level` e `recursive`, seguindo projeto → máquina → `t3.json` → `none`; somente a escolha explícita inicializa os submódulos. Seguem pendentes as camadas de ambientes conectados, políticas automáticas de projeto, outras preferências avançadas de worktree, tarefas agendadas com histórico e webhooks. Nas conversas TUI, trocar de provedor abre uma nova aba com handoff de texto limitado quando há transcript estruturado, sem encerrar a sessão original. O composer oferece autocomplete `@`, `/`, `$` e `#`; arquivos selecionados em `@` viram chips revisáveis pelo fluxo de anexos comum, enquanto menções `@agente` continuam funcionando para o time. `/compact`, `/autocompact` nativo e `/goal` usam os recursos disponíveis de Codex/Claude Code. O painel de Uso informado mostra total por conversa e, quando os agentes enviam os campos, a divisão por entrada, saída, cache e raciocínio; categorias podem se sobrepor e custo/preço ainda não é calculado. O detalhe de uso do ACP é experimental e sua semântica de escopo ainda precisa ser normalizada. O ditado local começou no macOS com reconhecimento no dispositivo, cancelamento e transcrição revisável; cada trecho para em 50 s e não envia a mensagem. Conversas estruturadas Codex, Claude Code, OpenCode e Antigravity por `agy --print` recebem o MCP da ADE e podem delegar tarefas ao roster de agentes disponíveis pelo scheduler existente; nas abas TUI, Codex, Claude Code, OpenCode e Hermes recebem MCP escopado ao processo, incluindo ferramentas de delegação; o Codex usa overrides `-c` por processo. A CLI atual do Kimi Code não oferece MCP por processo, então a ADE preserva suas configurações global e do projeto; Kimi continua disponível como executor e pode usar comandos `ags` pela ferramenta Shell quando a skill estiver montada. No Antigravity, a configuração MCP é temporária por turno, não uma sessão persistente. Conversas novas também podem ser iniciadas em segundo plano por ⌘/Ctrl+Enter, mantendo outro rascunho aberto. Configurações permitem famílias de fonte para interface e código, temas T3/VS Code e ajuste de movimento. Conversas por protocolo têm Side chat no painel, com histórico separado e retorno manual ao composer principal. O painel Browser inclui mini preview flutuante, arrastável e redimensionável; em conversas TUI e por protocolo, painel e agente ativo compartilham a mesma sessão e página. No WebView2 do Windows, cada agente/conversa mantém perfil persistente isolado; a pessoa pode criar perfis vazios, renomeá-los sem perder a sessão e alternar para o perfil compartilhado. A importação de sessões do Firefox entrou como primeira fatia (preview); a dos demais navegadores e dos perfis do WebView2 segue pendente, porque o WebView2 persiste cookies fora do chaveiro. Abrir a ADE como navegador padrão também segue pendente. A comparação de recursos, limites e próximas etapas está em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).

- **Referências ao contexto no composer:** no modo Chat T3, seleções do terminal, Diff e descrição/comentários de PR podem ser adicionadas como citação revisável à conversa. Resultados da busca local de mensagens também podem ser citados no composer da conversa estruturada selecionada. A paleta global `Ctrl+K` pesquisa mensagens estruturadas e transcripts TUI abertos de Claude Code/Codex; a busca de sessões arquivadas cobre Claude Code, Codex, Gemini CLI, Hermes, Kimi Code e OpenCode. A seleção de um resultado aberto salta à fala; uma fala arquivada abre prévia somente leitura sem relançar o agente. A origem fica visível e o conteúdo é marcado como dado não confiável, não instrução; nada é enviado automaticamente e cada citação respeita o teto de 1.500 caracteres. O chat do canvas mantém o caminho anterior. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Referências entre conversas:** resultados da busca local de mensagens podem ser citados como cartões revisáveis no composer da conversa estruturada selecionada. A origem, o agente e a autoria ficam visíveis; nada é enviado automaticamente. Resultados TUI suportados pela busca local também podem ser citados para uma conversa estruturada. A busca global inclui mensagens de conversas estruturadas e TUI aberta de Claude Code/Codex; transcripts TUI arquivados de Claude Code, Codex, Gemini CLI, Hermes, Kimi Code e OpenCode usam FTS temporário em memória, limitado a 4 MiB por sessão e 64 MiB no total, escopado ao workspace; o banco guarda apenas metadados. No Gemini, a busca usa projeto e ID exatos e ignora sessões de subagentes; Hermes é consultado somente no `state.db` local em modo somente leitura, com `SQLITE_LIMIT_LENGTH` de 4 MiB por valor/linha; wrappers injetados são filtrados e mensagens acima do limite tornam o resultado parcial. Kimi usa o índice oficial para validar o workspace e lê apenas o agente principal; linhas acima de 256 KiB são ignoradas e marcadas como parciais. Sessões ocultas não aparecem na busca. Agentes customizados continuam fora. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Respostas visuais do agente:** blocos `html`/`htm` na timeline podem ser abertos como páginas visuais sob demanda. A página roda em iframe sandbox sem origem ou sessão da ADE; a CSP restringe conexões e recursos externos, mas o HTML ainda executa scripts. O transcript continua guardando o código como texto. Ainda falta reconhecer uma resposta visual nativa do agente sem depender de bloco Markdown. Comparação e isolamento em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Navegação pelo histórico do terminal:** Shift+PageUp/PageDown percorrem uma página, ⌘/Ctrl+Shift+Home/End saltam ao início/fim, e ⌘+A no macOS ou Ctrl+Shift+A no Windows/Linux seleciona a saída. Esses atalhos só interceptam o buffer normal; TUIs em tela alternativa recebem as teclas. Fora do terminal, Ctrl+Shift+A continua abrindo a caixa de permissões. A retenção continua em 3 MiB por PTY até medir o impacto de aumentar o teto.
- **Comandos de terminal inspirados no T3:** `terminal.splitRight` e `terminal.splitDown` aparecem na paleta e aceitam atalhos configuráveis quando a sessão de agente está ativa no workspace. A divisão move a aba ativa se o grupo já tem outras abas; com uma aba só, abre um grupo vazio. `terminal.new` abre o assistente de nova sessão no workspace ativo pela paleta ou por atalho configurável; o agente só inicia após confirmação. `terminal.toggle` alterna a gaveta de Codex/Claude Code ou o shell lateral dos demais agentes, conforme o ícone Terminal do Chat. A sessão e o PTY existentes permanecem montados. Fechar e reabrir superfícies seguem pendentes; fechar precisa de confirmação para não encerrar o agente sem querer. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md).
- **Provedores ACP locais:** Configurações → Agentes → ACP cadastra executável e argumentos literais no chaveiro do sistema e inclui o agente no seletor de conversas, troca de agente e times. A conversa compartilha o transporte ACP do OpenCode, envia o MCP `ags` quando disponível e limita o acesso a Supervisionado. Depois do primeiro envio, o seletor usa os modelos `model` e níveis de raciocínio `thought_level` anunciados pela sessão, reaplica a escolha no turno seguinte e acompanha mudanças `config_option_update`. Retomada depende das capacidades anunciadas; ACP não garante que todo provider solicite permissão antes de agir. Autenticação por perfil, outros seletores `model_config`, uso normalizado e instalador continuam pendentes. Detalhes em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#provedores-acp-locais-configuráveis).

## Guia de revisão de PR por IA

Na tela de um PR, um agente (somente leitura, uma chamada headless) monta um roteiro de leitura com paradas: arquivos e linhas, por que importa, o que olhar de perto, trecho e perguntas. JSON validado estrito, com uma tentativa de conserto; cache por commit da cabeça, com aviso de desatualizado; passo a passo com teclado e visitadas; diff do arquivo no painel; "Perguntar sobre isto" abre um agente com o texto pré-preenchido, sem enviar. Nada é publicado no GitHub. Desenho, contrato e limites: [GUIA_REVISAO_PR.md](./GUIA_REVISAO_PR.md).

## Segurança local: editor, loopback, ambiente e aprovações

Quatro pontos da análise do `deepseek-harness`. O editor salva só se o arquivo tem o mesmo token `tamanho:mtime_ns:inode` de quando abriu, e recria um arquivo apagado com `create_new`. O proxy do navegador recusa `Host` que não é loopback, `Origin` de fora e subrecurso `cross-site` (o HMR do Vite segue funcionando). O ambiente da frota, do MCP do ai-memory e das abas de missão que pedem perde toda variável com `KEY`/`TOKEN`/`SECRET`/`PASSWORD`, menos as do provider; a conta e as `AGS_*`/`ADE_*` entram depois. Frota e chat gravam o mesmo par `asked`/`decided` em `approval_events`, com resultado fechado (`allowed-once`, `rejected`, `cancelled`, `unavailable`). Pendente: onde escolher e guardar o filtro por integrante. Detalhes em [SEGURANCA_LOCAL.md](./SEGURANCA_LOCAL.md).

## Contratos da CLI e do MCP (pontos do deepseek-harness)

- **Spill das respostas grandes** (`ipc/spill.rs`): acima de ~6.000 tokens, o resultado de uma tool do MCP ou de `tab output`/`tab screen`/`peer check`/`peer pending`/`chat show`/`chat wait`/`recall get` vai inteiro para `~/.ags/spill/<aba ou tarefa>/<aleatório>.txt` (pasta 0700, arquivo 0600, nunca dentro de um repositório, apagado após 30 dias) e o agente recebe cabeça, cauda e o caminho. `--no-spill` desliga na CLI.
- **`noProgress` na hora**: `ags events wait` (com `--run`/`--mission`, ou de um orquestrador) e o `run_await` da frota voltam logo quando nada trabalha nem provisiona, em vez de esperar o prazo. `--allow-idle` espera mesmo assim.
- **Profundidade e teto do `peer recruit`** (`squads/recruit.rs`): antes só havia a exigência da coroa. Agora a profundidade fica gravada (`~/.ags/recruits.json`, nunca desce), o padrão é 1 (recrutado não recruta) e há até 12 recrutados abertos por orquestrador; no limite, `{refused, reason, message}`.
- **Handoff v1.1** (`runs/handoff.rs`, aditivo): `status` opcional; `continue` exige `next_steps`, `complete` exige evidência (`evidence`, teste `passed` ou artefato), `blocked` exige `blockers` concretos. Report inválido é recusado inteiro.
- **`ask_user` com prazo** (padrão 600 s): ao vencer devolve `pending` (nunca aprovação), a pergunta fica na tela e a resposta tardia chega à aba como mensagem. Integrante de time recebe `refused` (`ask_lead`) e leva a dúvida ao orquestrador.
- **Regiões geradas**: a lista de tools na ajuda do `ags`, a tabela de tools da skill e de [CLI_MCP.md](../agentes/CLI_MCP.md#mcp) e o índice de comandos da skill saem do código entre `BEGIN/END GENERATED` (`bun run gen:catalogs`); `bun run check:catalogs` e um teste vitest conferem o frescor.
