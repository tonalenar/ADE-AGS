# Auditoria do Maestri e o que falta no ADE AGS

Data: 2026-10-13. Maestri 0.23.1 (build 90) instalado em `%LOCALAPPDATA%\Programs\Maestri`.

## Como foi feita e o que NÃO foi

Feito: leitura do pacote instalado (`app.asar`: processo principal, preload e o renderer, com as 2573 strings de interface em 42 namespaces, em inglês), as skills que o Maestri instala para os agentes (`~/.claude/skills/maestri*`, que documentam o CLI inteiro) e a gravação de tela do usuário (`20261013-1706-51.mp4`: diálogo "Novo portal", "Novo andar", visão 3D dos andares e minimapa).

Não feito:
- **Navegação pelas telas com computer-use (Haiku).** Esta sessão não tem ferramenta de controle de desktop (nem o app tem porta de depuração aberta), então nenhuma tela foi percorrida ao vivo. O inventário de strings cobre a lista de telas, menus e diálogos, mas não o comportamento visual.
- **Como o Maestri lê o uso do Antigravity.** Essa lógica está no host nativo (Swift) e em "provedores" configuráveis numa pasta de dados do usuário; ler essa pasta foi barrado pelo classificador de permissões (suspeita de explorar credenciais). Falta a definição do provedor do Antigravity (ver "Uso dos agentes").
- O CLI `maestri` só roda dentro de terminais do Maestri.

## O que é o Maestri (resumo técnico)

Electron + React 19 + jotai + xterm.js + node-pty, CLI nativo em Swift, canvas espacial com terminais, notas, portais (navegador), dispositivos Android, árvore de arquivos, desenhos e fichário de notas. Cada workspace é um canvas; **andares** são níveis dentro de um workspace. Fala com os agentes pelo CLI `maestri` (ask, check, recruit, connect, role, preset, routine, portal, device, floor, workspace, notify).

## Inventário por área, com a comparação

Contagem de textos de interface como régua de profundidade (Maestri em inglês; ADE AGS em pt-BR).

| Área | Maestri | ADE AGS hoje | Lacuna |
|---|---|---|---|
| **Andares** | ~353 textos | 13 textos (`canvas.floor.*`), barra de pílulas, criar só por nome e apagar | **Grande** (detalhes abaixo) |
| **Criar elemento no canvas** | ferramenta da barra + **arrastar para delimitar o tamanho**; "usar este tamanho" como padrão de novos elementos; leitura do tamanho (nunca / ao redimensionar / sempre) | cria com tamanho padrão | **Grande** |
| **Novo portal** | abas Navegador/Dispositivos; agente de usuário (Padrão Chromium, Chrome/Firefox/Edge desktop, Safari iPhone, Chrome/Firefox/Edge Android, personalizado); armazenamento (isolado / do workspace / global); descoberta de dispositivos | portal com URL e nome | Média |
| **Uso dos agentes** | painel com janelas Semanal e Sessão, "redefine em…", grupos de modelos (Gemini; Claude e GPT) no Antigravity; provedores configuráveis por pasta, restaurar padrões, anel colorido | `UsageBoard` + `antigravityQuota.ts` (lê `quotaInfo` do catálogo, mostra % usada); Antigravity marcado como "não medido" nos custos | Média: falta a janela Semanal/Sessão e os grupos |
| **Contas** | ~123 textos: várias contas por CLI, login/logout, chave de API, trocar conta de um agente em andamento ("replace") | contas e pools (failover, cooldown) | Pequena; vale o `recruit --replace` |
| **Rotinas** | ~82 textos: uma vez/intervalo/diário/semanal, fim por contagem ou data, pular se ocupado, **script de pré-execução** com variáveis, histórico | rotinas com `--every/--at/--in`, catch-up | Média: histórico, "pular se ocupado", script de pré-execução |
| **Paleta de comandos** | ~73: ask/check/connect/disconnect, buscar conversas, notificações, zoom, próximos workspaces | paleta (23 textos) | Média |
| **Compositor de prompt (prompter)** | ~52: menções a terminais/notas/portais/andares/ações, arquivos, texto colado vira bloco, imagens como caminho, dock abaixo/overlay | chat com `@agente` (novo) e 7 fios | Média |
| **Partitura (biblioteca de folhas)** | ~105: folhas globais/do workspace com importar/exportar, incluir histórico de chat | skills/papéis; sem biblioteca exportável | Média (similar a papéis+skills) |
| **Arquivos de configuração (Config Files)** | ~38: compara e sincroniza `CLAUDE.md` e `AGENTS.md` | não existe | **Boa ideia barata** |
| **Fichário** | ~30: pilhas de notas com páginas e busca | notas empilhadas (pilha) | Pequena |
| **Árvore de arquivos** | ~434: git integrado (modificado/novo/renomeado), checkout, merge, stash, ordenação, operações de arquivo, WSL | explorer (24 textos) + painel SCM (80) | Média |
| **Desenho** | ~45: caneta, formas, setas, preenchimentos, hachuras | caneta | Pequena |
| **Chat** | ~76: fios coloridos (inclui grafite), busca na conversa, histórico, anexos | chat com 7 fios, aba Equipe | Pequena |
| **Dispositivos Android** | ~56 | existe (`ags device`) | Pequena |
| **Git hosts / PR** | ~37 + os textos de PR nos andares | forge (171 textos) | Pequena (já temos), mas **não ligado aos andares** |
| **Preferências** | ~435: aparência, fundo (grade/liso/transparente), estilo das conexões (evitar nós/atrás/circuito), estilo de seleção, foco ao pairar, arrastar com botão direito, passo de zoom, opacidade da janela, **impedir suspensão** (nunca / enquanto agentes trabalham / enquanto o app está aberto), confirmar saída | settings (424 textos) | Média: foco ao pairar, arrastar-direito, impedir suspensão, estilo de conexão |
| **Controle remoto ("Wire")** | pareamento de outros dispositivos para controlar o app, criptografado, beta | não existe | Grande, mas fora do escopo imediato |
| **SSH/WSL** | workspaces em máquinas remotas, WSL | não existe | Fora do escopo |

## Andares: o que o Maestri tem e nós não

Hoje os andares do ADE AGS são um worktree git nomeado, uma barra de pílulas e "apagar". No Maestri:

1. **Dois tipos de isolamento:** worktree git (compartilha histórico; o branch não pode estar em outro lugar) ou **cópia independente** (clone próprio, pode usar o mesmo branch do Térreo). Sem git: andar que só tem canvas próprio, na mesma pasta.
2. **Criação:** nome; interruptor "isolamento de repositório"; **escolher branch existente (busca) ou criar branch novo**; **criar a partir de um pull request** (busca ou colar link); **pastas excluídas** da cópia (dependências grandes); **clonar o layout do Térreo**; progresso de cópia (arquivos e bytes) com cancelamento; recusas explicadas (sem git, sem commits, branch inválido, branch em uso em outro andar…).
3. **Semear o andar:** cópia com copy-on-write do Térreo (inclui dependências e configurações locais, sem cache de build) em vez de só checkout.
4. **Hooks do andar:** comandos de **setup** (ao criar), **run** (botão play) e **teardown** (ao apagar), com variáveis `MAESTRI_FLOOR_NAME`, `…_BRANCH_NAME`, `…_FLOOR_PATH`, `…_ROOT_PATH`, `…_PROJECT_NAME`, reordenáveis, com saída e código de saída.
5. **Aterrissar (land):** folha com diff e contagem de commits, **branch de destino**, apagar branch depois, **manter ou descartar o andar**, aviso de conflito, de mudanças não commitadas e de "nada a aterrissar"; **pedir a um agente para resolver os conflitos** direto da folha.
6. **Pull request do andar:** abrir PR (push do branch, título, descrição, rascunho, **modelo de PR do repositório**, imagens coladas), acompanhar (revisão, checks, conflitos, aprovado), **método de merge** (merge/squash/rebase), **pedir a um agente** para revisar, corrigir checks ou resolver conflitos.
7. **Status do andar** (uma linha na barra lateral): estado trabalhando/bloqueado/pronto para revisão/concluído, progresso `2/5`, e notificação ao mudar para bloqueado/revisão/concluído; o agente posta pelo CLI (`maestri floor status`).
8. **Navegação:** visão 3D empilhada dos andares com o "Térreo" e "+ Novo andar", cartão por andar (contagem de itens), menu de contexto (renomear, aterrissar, descarregar, apagar, definir status, copiar nome do branch), **descarregar** (liberar memória sem apagar), navegação entre andares de agentes (cross-floor).
9. **CLI:** `floor create/land/delete/list/status/unload`, `recruit --floor`, `workspace create --from` (clona um workspace-modelo), agrupar workspaces em grupos e pastas.

## Criar uma "janela" (elemento) com tamanho delimitado

O usuário descreve: ao criar uma nova janela, delimitar o tamanho. No Maestri a barra do canvas tem uma ferramenta por tipo (selecionar, terminal, recorte, anexo, pasta, portal, texto, caneta). Com a ferramenta ativa, **arrasta-se um retângulo no canvas** e o elemento nasce com aquele tamanho. O menu de contexto oferece "usar este tamanho" (vira o padrão dos novos elementos) e "mostrar tamanho" (nunca / ao redimensionar / sempre). Há também alinhar (esquerda, direita, topo, base, centralizar), **arrumar (tidy)**, agrupar, bloquear/desbloquear, desfocar e copiar captura de tela de um elemento.

## Uso dos agentes e o Antigravity

A tela do usuário mostra, para o Antigravity, dois grupos de modelos (Gemini; Claude e GPT) e, em cada um, o uso **Semanal** (ex. 16%, redefine em 4 dias) e de **Sessão** (ex. 7%, redefine em 3 horas). Nosso app já consulta o catálogo de modelos do Antigravity e lê `quotaInfo.remainingFraction` e `resetTime` por modelo (`accounts/antigravity_access.rs`, `canvas/antigravityQuota.ts`), mas só uma janela. Para chegar na tela do Maestri é preciso saber como ele separa semanal de sessão (provedor do Antigravity, pasta de provedores do usuário). **Pendente de leitura autorizada.**

## Backlog proposto (ordem de valor/risco)

1. **P1. Desenhar para criar com tamanho** (terminal, nota, portal, texto, árvore) + "usar este tamanho" + leitura do tamanho. Só frontend; risco baixo.
2. **P1. Andares, onda 1 (criação e navegação):** dialogo "Novo andar" completo (isolamento git on/off, branch existente/novo com busca, clonar layout do Térreo, pastas excluídas, progresso, recusas explicadas), cartão por andar, menu de contexto, copiar nome do branch, descarregar.
3. **P1. Andares, onda 2 (aterrissar):** folha com diff, branch de destino, apagar branch, manter/descartar andar, pedir a um agente para resolver conflito.
4. **P2. Status do andar** (estado, progresso, notificação) com `ags floor status` para os agentes.
5. **P2. Andares, onda 3:** hooks (setup/run/teardown) e cópia independente; criar andar a partir de PR e abrir PR do andar reutilizando o módulo forge.
6. **P2. Uso do Antigravity** com janelas Semanal/Sessão e grupos de modelos (depende da leitura do provedor).
7. **P2. Config Files** (comparar/sincronizar `CLAUDE.md` e `AGENTS.md`).
8. **P3. Portal:** agente de usuário e armazenamento (isolado/workspace/global).
9. **P3. Rotinas:** histórico, "pular se ocupado", script de pré-execução.
10. **P3. Preferências do canvas:** foco ao pairar, arrastar com botão direito, passo de zoom, estilo de conexão, impedir suspensão.
11. **P3. Alinhar/arrumar/agrupar/bloquear elementos** e captura de tela de elemento.
12. **Fora de escopo agora:** Maestri Wire (controle remoto), SSH e WSL.

## Observações de cuidado

- Este documento descreve funcionalidades por observação do app instalado e das skills que ele grava para os agentes; não reproduz o código nem os textos do Maestri. A implementação no ADE AGS deve ser própria.
- A comparação de contagem de textos é uma régua de profundidade, não de qualidade.
