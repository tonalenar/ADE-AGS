# Linha de Base de Eficiência entre Agentes (Etapas 5 a 10)

> **Documento de Referência:** Registrado em modo estritamente somente leitura a partir do banco de dados local (`~/.ags/data.db`) e spans de telemetria das missões anteriores à Etapa 11.
> **Destino:** `docs/ade-ags/AGENT_EFFICIENCY_BASELINE.md` (worktree `ADE-AGS-e11-p4-metricas`).

---

## 1. Contexto e Objetivo

Antes das implementações da **Etapa 11 (Eficiência entre agentes)**, observou-se que adicionar mais agentes a uma missão não resultava necessariamente em maior velocidade, podendo torná-la significativamente mais lenta e cara.

Os objetivos desta linha de base são:
1. Mapear o comportamento histórico real de tempo de relógio, tempo ativo medido, número de agentes, custos e spans nas últimas missões concluídas.
2. Identificar com precisão os gargalos estruturais de comunicação e sincronização que justificam as melhorias dos Pontos 1 a 5.
3. Estabelecer o marco comparativo reproduzível contra o qual os ganhos da Etapa 11 serão avaliados.

---

## 2. Histórico de Missões Anteriores (Dados Brutos Extraídos de `data.db`)

A consulta em modo somente leitura no banco SQLite (`~/.ags/data.db`) das missões concluídas revelou o seguinte quadro histórico:

| Missão / Etapa | ID Completo | Status | Relógio (Wall) | Tempo Ativo Medido | Spans Totais | Spans Boot | Spans Turn (Briefing) | Spans Peer Ask | Agentes Ativos | Custo Estimado (Ledger) |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Etapa 10 — Taxa de sucesso** | `02b9294a-add8-4f8e-824a-df00d6e77859` | `done_without_delivery` | 8.291 s (~2h 18m) | 60.266 ms (~1m 00s) | 8 | 4 | 4 | 0 | 4 | n/d (não medido) |
| **Etapa 9 — Aba Ao vivo no QG** | `5519704d-b5cc-43a9-b2b7-c08ee3e42938` | `done` | 40.873 s (~11h 21m) | 436.279 ms (~7m 16s) | 8 | 4 | 4 | 0 | 4 | n/d (não medido) |
| **Etapa 8 — Custo por aba e conversa** | `e7f62d88-1f65-43a9-a4fb-3671566bc32c` | `done` | 43.489 s (~12h 04m) | 449.709 ms (~7m 30s) | 8 | 4 | 4 | 0 | 4 | n/d (não medido) |
| **Etapa 6 — Event Bus e watch** | `c643e561-e439-4e2f-ad04-675b5f1d8366` | `done` | 7.230 s (~2h 00m) | 580.460 ms (~9m 40s) | 8 | 4 | 4 | 0 | 4 | n/d (não medido) |
| **Etapa 7 — Usage/custo uniforme** | `36ee5832-41f1-4a60-a208-e05d201996d8` | `done` | 4.268 s (~1h 11m) | 123.850 ms (~2m 04s) | 7 | 4 | 3 | 0 | 4 | n/d (não medido) |
| **Etapa 5 — Atualização automática** | `8541b738-ff58-4e6a-a6c3-7c4145650911` | `done` | 3.933 s (~1h 05m) | 1.165.948 ms (~19m 26s) | 8 | 4 | 4 | 0 | 4 | n/d (não medido) |
| **Terminais multimodais** | `a536f7e9-9fb5-4769-8480-69a75b038100` | `done` | 19.174 s (~5h 19m) | 810.640 ms (~13m 30s) | 8 | 4 | 4 | 0 | 4 | n/d (não medido) |
| **Painel de tokens e custo** | `633fa963-d158-4130-aec4-07e668d5cb68` | `done` | 4.756 s (~1h 19m) | 1.508.934 ms (~25m 08s) | 11 | 4 | 4 | 3 | 4 | n/d (não medido) |
| **Etapa 4/4 — Failover de contas** | `e307973c-99ea-4085-a6da-4c2d51869369` | `done` | 41.134 s (~11h 25m) | 1.237.550 ms (~20m 37s) | 12 | 4 | 4 | 4 | 4 | n/d (não medido) |
| **Etapa 3/4 — MCP por missão** | `b57671c2-6c6b-47b2-b8ae-ed7904f2b37f` | `done` | 7.598 s (~2h 06m) | 912.210 ms (~15m 12s) | 9 | 4 | 4 | 1 | 4 | n/d (não medido) |

### 2.1. Fonte e Reprodutibilidade dos Dados

Os dados foram obtidos exclusivamente por leitura direta do banco `~/.ags/data.db`:
- **Tabela `missions`**:
  - Campos: `id`, `title`, `status`, `started_at`, `ended_at`.
  - O tempo total de relógio é obtido via `wall = ended_at - started_at`.
- **Tabela `mission_timings`**:
  - Campos: `kind`, `started_ms`, `ended_ms`, `actor`, `target`.
  - O tempo ativo corresponde à união dos intervalos `[started_ms, ended_ms]` de spans `turn` e `peer_ask`, consolidando trechos sobrepostos para medir o trabalho real sem duplicar tempo de agentes simultâneos.
- **Tabela `usage_events` / `runs`**:
  - Campos: `cost_usd`, `spent_usd`.
  - Ausência de registro de custo para TUIs de canvas resulta em `NULL` / `measured=false`.

*Nota sobre a Etapa 11 no momento da medição:*
- `f754b31f-0f96-4be9-873f-f290c4e9966e`: Status `running`, 7 spans iniciais (4 boot + 3 briefing = 16.509 ms ativo), 4 agentes iniciais.

---

## 3. Diagnóstico dos Gargalos da Linha de Base

A análise detalhada dos registros históricos evidencia 5 problemas críticos:

### 3.1. Sub-registro Crônico de Spans (Apenas Briefing Inicial)
- **Fato observado:** Nas Etapas 5 a 10, **100% das missões** registravam exclusivamente os 4 spans de `boot` e os 3 a 4 primeiros turnos de `briefing`.
- **Efeito:** Todo o trabalho real posterior dos agentes (que se estendia por 2 a 12 horas de relógio) ocorria em total obscuridade telemétrica.
- **Diferença gritante:** Na Etapa 8, o relógio correu por 43.489 segundos (~12 horas), mas a soma dos spans registrados em `mission_timings` totalizou meros 449 segundos (~7,5 minutos), cobrindo apenas o briefing.

### 3.2. Ausência de Telemetria de Bloqueio em `peer_ask` (Invisibilidade de Gargalos)
- **Fato observado:** O Ponto 2 da Etapa 8 (prazo configurável e respostas parciais para `peer_ask`) **não havia sido entregue**.
- **Efeito:** Nas Etapas 8, 9 e 10, foram registrados exatamente **0 spans** de `peer_ask`. Quando um agente consultava outro, a chamada bloqueava a thread por tempo indeterminado (até 600 segundos no padrão) sem registrar quem estava esperando quem, impedindo qualquer relatório ou diagnóstico de gargalos.

### 3.3. Agentes Parados Silenciosos sem Notificação Automática
- **Fato observado:** Se um agente recebia uma tarefa via `ags peer tell` e sofria timeout de modelo, erro de sandbox (ex.: `index.lock` do git) ou simplesmente parava após emitir texto explicativo no terminal sem efetuar o commit ou notificação, o orquestrador ficava aguardando indefinidamente.
- **Caso real reproduzido na Etapa 11:** O agente `Metricas` (Codex) concluiu seu primeiro ciclo de análise, imprimiu o resumo e parou por 4m 54s sem commitar nem responder ao orquestrador. Sem o detector de agente parado (Ponto 1), a missão permaneceria bloqueada até intervenção manual do usuário.

### 3.4. Custo e Medição de Tokens nas TUIs do Canvas
- **Fato observado:** O campo `cost_usd` no ledger `usage_events` para missões interativas de canvas é `NULL` (ou `measured=false`) em todas as missões recentes, constando na linha de base como `n/d (não medido)` (e não como `$0.00`, que sugeriria incorretamente custo zero/gratuito).
- **Causa documentada na memória (`agentes-sem-leitor-usage`):** Apenas Claude Code persiste tokens exatos em transcripts JSONL. Codex, Antigravity e OpenCode operam em terminais PTY cujos tokens não são expostos em disco pela TUI, devendo ser tratados como `measured=false` (campos NULL).
- **Implicação:** A mensuração de eficiência entre agentes nessas interfaces não pode depender exclusivamente de custo de API externo, exigindo medições de tempo ativo, tempo de relógio e contagem de mensagens.

### 3.5. Sobrecarga de Comunicação (Conversas Fragmentadas)
- **Fato observado:** As comunicações entre orquestrador e integrantes seguiam padrão informal e fragmentado. O orquestrador precisava perguntar repetidamente por arquivos tocados, decisões, testes executados e impedimentos.
- **Medição sintética controlada (estimativa UTF-8 / 4 tokens — Modelo Teórico do Ponto 5):**

> **Nota Metodológica:** A tabela abaixo apresenta uma **medição sintética controlada** para comparar o fluxo fragmentado com a entrega estruturada (proposta pelo Ponto 5), não se tratando de dados telemétricos históricos extraídos do banco de dados.

| Padrão | Fluxo de Mensagens | Total de Mensagens | Tokens Totais Estimados |
|---|---|---:|---:|
| **Antes (Fragmentado / Informal)** | 1. Integrante: *"Terminei a implementação."* (7 t)<br>2. Orquestrador: *"Quais arquivos alterou e decisões tomou?"* (14 t)<br>3. Integrante: *"Alterei src/feature.ts; mantive o contrato."* (13 t)<br>4. Orquestrador: *"Quais testes executou e houve bloqueio?"* (12 t)<br>5. Integrante: *"Vitest passou; sem bloqueios."* (8 t) | **5 mensagens** | **~54 tokens** |
| **Depois (Handoff Estruturado / Ponto 5)** | 1. Integrante: `resultado=implementado; decisões=mantive contrato; arquivos=src/feature.ts; testes=vitest (passou); bloqueios=nenhum` (32 t) | **1 mensagem** | **~32 tokens** |
| **Ganho Líquido da Padronização** | **Redução de idas e vindas de 5 para 1 mensagem** | **-80% de mensagens** | **-41% de tokens** |

---

## 4. Síntese dos Indicadores da Linha de Base para Comparação

Para comprovar formalmente a melhora com a entrega da Etapa 11, os seguintes critérios devem ser avaliados:

1. **Cobertura de Spans:** De 8 spans por missão (restritos a boot/briefing) para registro contínuo de **todos os turnos** e de todas as chamadas `peer_ask`.
2. **Tempo Bloqueado em `peer_ask`:** De espera cega e não rastreada para prazo configurável, resposta parcial sob demanda e relatório de gargalos (`bottlenecks`).
3. **Resiliência a Agentes Parados:** De espera infinita para alerta automático (`stallMessage`) após 120s de inatividade sustentada sem falso alarme para pensamento ou diálogo com o usuário.
4. **Setup de Worktree:** De configuração manual de junctions e `CARGO_TARGET_DIR` para briefing padronizado e automatizado no provisionamento.
5. **Comunicação por Tarefa:** De ~5 mensagens e ~54 tokens fragmentados para 1 entrega estruturada de ~32 tokens (-41% tokens).

---

*Linha de base homologada pela equipe de QA / Tests em 05/10/2026.*
