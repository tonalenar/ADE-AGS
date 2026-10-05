# Checklist de Aceite e Casos de Teste — Etapa 15

Este documento define os critérios de aceite, cenários de teste automatizados e matriz de verificação para os cinco pontos da **Etapa 15 — Início rápido, Ao vivo que funciona e abas**.

---

## 1. Ponto 1 — Início rápido da missão

### Critérios de Aceite
- [ ] **Métrica no backend:** `missions::timings::first_delegation` calcula `(Option<i64>, Option<&'static str>)` a partir do baseline (`boot` ou `started_at * 1000`) e da primeira delegação (`peer_message` com detalhe `delegation`, ou fallback `peer_ask`).
- [ ] **Resumo de timings:** Estrutura exposta via IPC e CLI `ags mission timings <id>` inclui `firstDelegationMs` e `firstDelegationSource`.
- [ ] **QG do bot:** Painel de tempos exibe "Tempo até 1ª delegação" com a fonte apurada; sem dados válidos, exibe "não medido" / traço sem quebras.
- [ ] **Briefing do Orquestrador:** Contém regra estrita de elaboração de plano conciso e delegação a todos os integrantes em até ~2 minutos antes de qualquer exploração no código.
- [ ] **Briefing dos Membros:** Contém instrução explícita de espera ativa: não explorar código nem editar arquivos antes do recebimento formal da tarefa e atribuição do worktree.
- [ ] **Isolamento de Worktrees:** Cada integrante possui seu próprio worktree (`e15-backend`, `e15-frontend`, `e15-qa`) com branch independente derivada de `origin/master`, junction de `node_modules` (Windows) e target Cargo configurado (`CARGO_TARGET_DIR` por worktree/review).
- [ ] **Pré-preenchimento:** Informações do precheck e de memórias aprovadas da missão são injetadas no briefing inicial para evitar buscas redundantes.

### Casos de Teste (Rust / Unit)
- `test_first_delegation_with_peer_message`: baseline de boot + mensagem de delegação retorna `(Some(diff), Some("peer_message"))`.
- `test_first_delegation_fallback_peer_ask`: baseline de boot + `peer_ask` do Orquestrador retorna `(Some(diff), Some("span"))`.
- `test_first_delegation_unmeasured_when_empty`: sem eventos de delegação retorna `(None, None)`.
- `test_first_delegation_inverted_clock`: se timestamp de delegação for anterior ao início, trata como relógio inválido e retorna `(None, None)`.

---

## 2. Ponto 2 — 'X' nas abas de missão

### Critérios de Aceite
- [ ] **Botão 'X' visível:** Cada aba/chip de missão ativa no topo (`MissionChips.tsx`) exibe um botão de fechamento com ícone 'X'.
- [ ] **Missão em andamento (`running`):** Clicar no 'X' abre modal de confirmação (`missions.chips.closeTitle`), alertando que fechar a aba encerra os terminais dos agentes em execução.
- [ ] **Confirmação:** Clicar em "Fechar missão" (`missions.chips.closeConfirm`) fecha todos os terminais associados àquela missão. Clicar em "Cancelar" fecha o modal sem encerrar nada.
- [ ] **Missão concluída ou inativa:** Se o status não for `running`, fechar a aba via 'X' encerra as abas imediatamente sem diálogo de confirmação redundante.
- [ ] **i18n:** Textos presentes e consistentes em `pt-BR.json`, `en.json` e `es.json`.

### Casos de Teste (Vitest / Component)
- `closeMissionNeedsConfirm`: retorna `true` para `running` e `false` para `done`, `failed`, `draft` ou `undefined`.
- `MissionChips`: renderiza botão 'X' com `title` e `aria-label` traduzidos; evento de clique propaga a solicitação de fechamento sem disparar a navegação da aba.

---

## 3. Ponto 3 — Ao vivo que funciona (LiveArcade)

### Critérios de Aceite
- [ ] **Missões em terminais:** Heróis não ficam estagnados no chão (nível 0 / viga inferior). O andar do herói é derivado dinamicamente:
  - Briefing / aguardando tarefa = Andar 1 (Abertura);
  - Saída sustentada (`sustainedTabIds`) = Andar 2 (Trabalho);
  - Papel QA / testes = Andar 3 (Testes);
  - Papel Revisor = Andar 4 (Revisão);
  - Conclusão / entrega = Andar 5 (Entrega).
- [ ] **Movimentação física:** Heróis caminham pelas vigas e utilizam escadas reais para transicionar de nível verticalmente.
- [ ] **Comportamentos animados:**
  - Patrulha horizontal durante saída sustentada (`running`).
  - Dormência (`sleeping` / sprite com `Z`) quando inativo / sem saída.
  - Alerta (`!` / `stopped`) em casos de bloqueio, aprovação pendente ou peer ask expirado.
- [ ] **Torre de blocos:** Cada entrega final recebida (via `peer tell` padronizado de encerramento) adiciona um bloco à torre de tarefas concluídas.
- [ ] **Barris reais:** Somente criados por eventos mensuráveis reais (aprovação pendente, checagens falhando, memórias sugeridas sem resposta, timeout de peer ask).
- [ ] **HUD "Tempo ativo":** Consome a fonte unificada `activeSeconds` / `activeSource` da Etapa 14; enquanto a missão roda, apresenta tempo ativo real em vez de "não medido"; sem dados disponíveis, exibe cinza neutro.

### Casos de Teste (Vitest / Model & Scene)
- Derivação de estágio por papel funcional quando `tasks` estiver vazio (cenário real de terminais).
- Transição de andar ao alternar atividade e papéis.
- Atualização da torre ao receber entrega final via peer message.

---

## 4. Ponto 4 — Logos em pixel art na legenda

### Critérios de Aceite
- [ ] **Substituição:** O quadrado de cor sólida na legenda ao lado de "Orquestrador · Claude CORRENDO" é substituído por um ícone pixel-art 12x12 da plataforma correspondente.
- [ ] **Plataformas suportadas:** Claude, Codex, Antigravity, Gemini, OpenCode e genérico.
- [ ] **Zero dependência externa:** O desenho dos ícones é feito programmaticamente via Canvas / CSS, sem requisições HTTP, SVGs pesados ou imagens estáticas externas.
- [ ] **Legibilidade:** Ícones com dimensões exatas de 12x12 px, mantendo contraste nítido nos temas claro e escuro.

### Casos de Teste (Vitest / Canvas)
- Validação do mapeamento de plataforma para sprite/canvas do logo.
- Garantia de fallback para logo genérico em agentes desconhecidos.

---

## 5. Ponto 5 — Modo abas: panes lado a lado em grade

### Critérios de Aceite
- [ ] **Opção de grade:** Na visualização de abas da missão (ao lado de Canvas), existe um seletor/botão para exibir todos os panes lado a lado em grade.
- [ ] **Escopo individual por missão:** A preferência de visualização (grade vs. abas individuais) é persistida por missão/aba (`localStorage` ou store indexado pelo ID da missão), não de forma global.
- [ ] **Comportamento padrão preservado:** Missões sem preferência configurada mantêm o comportamento padrão atual (modo abas empilhado/individual).
- [ ] **Disposição em grade:** Quando ativo, divide o espaço disponível uniformemente entre todos os terminais abertos da missão.
- [ ] **i18n:** Rótulos e tooltips em pt-BR, en e es.

---

## Matriz de Validação e Verificação Cruzada

| Ponto | Componente | Responsável | Status Verificação QA |
|---|---|---|---|
| 1 | `first_delegation` em `timings.rs` | Backend | Testado unitariamente em Rust |
| 1 | Briefings e isolamento de worktree | Orquestrador / Infra | Validado estruturalmente |
| 2 | Botão 'X' em `MissionChips.tsx` | Frontend | Em verificação nos worktrees |
| 3 | Sinais reais no `LiveArcade` | Frontend / Bot | Em verificação nos worktrees |
| 4 | Logos pixel-art 12x12 | Frontend / Bot | Em verificação nos worktrees |
| 5 | Panes lado a lado individual | Frontend / Canvas | Em verificação nos worktrees |
