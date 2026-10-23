# Jev: decisões tipadas

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

## Regras
- **O produto nunca depende de o Jev responder.** Se ele falhar, a função devolve `None` e a regra local segue. O modo sombra nunca altera o retorno.
- **Cada consulta custa cota.** Não rode o bench real (`scripts/jev-bench.ts --real`), o `jev-done-probe` nem o `jev-pilot-sim` sem o OK do usuário, e informe sempre o teto (`--max-real`, `--max-probes`). Para testar lógica, use `--sim`, que é grátis. O "Testar conexão" e a atualização automática do modelo também fazem consultas.
- A cada medida, use **sementes novas**: uma semente já usada deixa de ser teste.
- Ao ler a resposta, use a **probabilidade** do rótulo, não a `confidence`.
- **Privacidade**:
  - o log guarda só o hash do state;
  - o que o detector de segredo marca não sai da máquina;
  - foto não sai com campo sensível preenchido;
  - valores de `--fill` nunca vão ao provedor;
  - a chave fica só no keyring.
- Para quem mexe no código:
  - mudou o texto de uma regra (`browse_rules.rs`)? Suba `RULES_VERSION` e meça antes e depois;
  - mudar um limite `MIN_*` exige dados de calibração;
  - ponto novo nasce **desligado**, com chave `decisions.point.*` (em `config.rs`, no DTO de `commands.rs`, em `decisionsModel.ts` e no i18n), e grava uma `LogRow` com a heurística ao lado;
  - nunca segure o mutex do banco durante o HTTP;
  - o piloto fica puro, com as dependências injetadas por `PilotDeps`.

## O que é
- O app envia um `state` (texto) e **perguntas fechadas**, e recebe de volta um **rótulo e uma probabilidade**. Nunca recebe texto livre.
- Há um cliente único (`src-tauri/src/decisions/http.rs`): `POST {base}/v1/systemone`, com `Authorization: Bearer` e corpo `{state, questions, model}`.
- Provedores (`config.rs`):
  - `none`;
  - `laya_local` (`localhost:8000`);
  - `laya_studio`;
  - **`jev`** (TypeSafe, `https://api.typesafe.ai`);
  - `clef` (stub).
- Tipos de pergunta:
  - `choice`, com critérios por id;
  - `noul`, sim/não;
  - `box`, para visão.
- Limites:
  - Jev: state ≤ 64.000 caracteres e ≤ 100 opções;
  - Laya: ≤ 4.096 caracteres e ≤ 19 opções.
- Erros têm `fault()` = `rede | provedor | local`, e a chave é removida do texto (`shadow::redact`).
- **Modelos** (`jev_models.rs`):
  - apelidos `jev-latest` (o padrão) e `jev-preview`; versões no formato `jev-X.Y.Z`;
  - `decisions.model_auto_update` (ligado por padrão) sobe uma versão fixada para a mais nova. Apelido nunca muda;
  - descoberta ao abrir o app e depois a cada 24 h: `GET /v1/models`, um ping e uma sonda da próxima versão.
- **Chave**: só no keyring, serviço `ade-ags.decisions`, contas `api-key` e `api-key-secondary`.
- **Ajustes** (tabela `settings`):
  - `decisions.enabled`, `.provider`, `.base_url` (HTTPS, ou HTTP só para localhost), `.model`;
  - `.timeout_ms`: padrão 800;
  - `.secondary.*`: um segundo provedor, para comparar;
  - `decisions.point.*`.
- **Código**:
  - backend em `src-tauri/src/decisions/` (`protocol`, `http`, `config`, `jev_models`, `points`, `shadow`, `log`, `scorecard`, `hints`, `delivery`, `routing`, `relevance`, `browse`, `browse_rules`, `vision`, `commands`);
  - frontend: `features/browser/jevPilot.ts`, `agentBridge.ts`, `missions/vigia.ts`, `canvas/routeSuggestion.ts`, `memory/jevHints.ts`, `settings/DecisionsSection.tsx`.

## Pontos de decisão
Todos nascem **desligados**.

| Ponto | Decide | Modo | Heurística local |
|---|---|---|---|
| `memory_approval` | aprovar/rejeitar/revisar uma proposta; segredo | sombra; a tela só **sugere** (pré-seleciona com p ≥ 0,45) e quem clica é a pessoa | duplicata → rejeitar, senão revisar |
| `dream_triage` | manter/juntar/descartar uma proposta do sonho | sombra | duplicata → juntar |
| `fleet_gate` | lançar/esperar/pular uma task | sombra | `scheduler::decide` |
| `mission_gate` | entregar/reter | sombra | status da entrega |
| `delivery_gate` | se a mensagem ao lead é `final`, andamento, pergunta ou conversa | **ajuda**: confirma um "final" que a regra do [Vigia](VIGIA.md) não reconheceu (p ≥ 0,5; 600 caracteres) | `isFinalReport` |
| `memory_relevance` | quais memórias entram no briefing | **ajuda** (≤ 10 de 30; 160 caracteres por corpo) | BM25 |
| `turn_routing` | destinatário de uma mensagem sem @ na aba Equipe | **sugere** um chip; a pessoa clica | sobreposição de palavras |
| `browser_step` | próxima operação e elemento no piloto | **decide** (o agente pediu o `act`) | nenhuma (as guardas ficam no piloto) |
| `browser_vision` | na foto: existe / caixa / número | **decide**, como reserva do piloto (só Jev, `jev-preview`) | nenhuma |

- Os pontos que ajudam só consultam o provedor principal e gravam uma linha no log por consulta.
- O Vigia em Rust (`missions/vigia.rs`) **não** chama o Jev; quem chama é o `vigia.ts`.
- **Não existe** ponto de seleção de modelo via Jev no app.

## Modo sombra
- A função que decide **continua devolvendo o próprio resultado**. Em paralelo:
  1. monta um `ShadowJob`;
  2. `shadow::enqueue` põe o job numa fila global (128 itens; o excedente é descartado);
  3. um único trabalhador processa a fila.
- Cada job vai a todos os destinos (principal e secundário).
  - Destino que sai da máquina pula o que é sensível.
  - Dedupe de 1 h e nenhum retry.
- `decision_shadow_log` guarda:
  - o **hash** do state (nunca o texto);
  - a heurística e a decisão do provedor;
  - a probabilidade, a latência e os tokens.
  - Retenção: 30 dias ou 50.000 linhas. A decisão humana vai para `decision_human_log`.
- O relatório (Ajustes → Decisões) mostra:
  - concordância (amostra baixa abaixo de 30);
  - p50/p95 e erros;
  - `blind_rate`;
  - provedor A × B e cada um contra o humano;
  - exportação em CSV.
- **Scorecard da limpeza**: apagar pelo diálogo vira uma rejeição humana, o que mede o recall e os falsos alarmes do Jev.
- **Promover** um ponto de sombra para ativo exige concordância ≥ 90%, p95 aceitável e revisão das discordâncias (`docs/decisoes/LAYA_LOCAL.md`). Ainda não há interruptor para isso.

## Piloto do navegador (`ags portal act` / MCP `browser_act`)
- **Comando**: `ags portal act <portal> "objetivo" [--fill campo=valor]… [--expect text:|url:|count:|absent:…]… [--steps 8]`.
  - Timeout de 115 s.
  - Um `--expect` malformado é recusado antes de agir.
- **Laço** (`src/features/browser/jevPilot.ts`):
  1. Preconecta e lê o histórico do portal (`portalLedger.ts`).
  2. Se o objetivo pede para digitar e não veio `--fill`, recusa.
  3. A cada passo:
     - lê a página: elementos `eN`, estado, preenchido sim/não; **valores e senhas nunca saem**;
     - preenche os `--fill` sem o Jev (o texto digitado vem **só** do `--fill`);
     - fecha cookie/modal **recusando**.
  4. Faz **uma** consulta com três perguntas: `operacao` (click/type/select/scroll/wait/done/stuck), o alvo da operação e `concluido`. As regras do prompt ficam em `browse_rules.rs` (`RULES_VERSION`).
  5. Do lado Rust (`browse.rs::pick`): ids seguros e varredura de segredos. Se achar um segredo, **não chama** o provedor.
- **Desfechos**:
  - **feito** com `concluido` ≥ 0,75, conferido contra contradições e contra os `--expect`;
  - **unsure**: p abaixo de 0,4, ou elemento sem nome ambíguo, e a foto não resolveu;
  - **stuck**: o Jev respondeu `stuck`, ou houve ciclo de páginas;
  - **done** direto, sem perguntar, quando um `--expect` vira verdadeiro;
  - **limit**: estourou o orçamento de 8 passos (máximo 15).
  - O relatório sai como **FEITO (verificado)**, **FEITO (não verificado)** ou **NÃO CONFERE**.
- **Foto (reserva)**:
  - só com `browser_vision` ligado e o Jev como provedor; no máximo 3 por `act`;
  - lê só PNGs da pasta de capturas do app;
  - a foto ampliada numera os ícones sem nome com selos 1..9 (aceita com p ≥ 0,6);
  - **não sai nenhuma foto** com campo de senha, cartão, token ou CPF preenchido.
- **Garantias**:
  - nunca compra, finaliza ou paga sem que o objetivo peça;
  - não adiciona o mesmo item duas vezes ao carrinho;
  - texto da página é dado, não instrução;
  - lista curta de operações, sem eval, upload ou cookies;
  - portal limitado ao projeto e aos portais conectados.
- **Cliente HTTP**: `RetryPolicy::Patient`, só no piloto (até 3 tentativas, prazo de 10 s). Timeout adaptativo de 3×p95 + 400 ms, com teto de 12 s.

## Laya local
- Instalação: `py -m pip install "laya[serve]"` + `laya-serve` (`127.0.0.1:8000`, modelo `multilingual`).
- Usa o mesmo protocolo, mas sem `/v1/models`.
- Por ser local, pode receber dados sensíveis no modo sombra.
- Serve de segundo provedor na comparação. O piloto e a visão foram pensados para o Jev.

## Bench (`scripts/jev-bench.ts`, `docs/ade-ags/bench/`)
- **Conjuntos**:
  - originais (treino);
  - `--set teste`: 5 famílias da `loja.html`;
  - `--set teste2`: 7 famílias × 20, em PT/EN/ES.
- **Metas** (`PROTOCOLO_J2.md`):
  - sucesso ≥ 98% em tarefas nunca vistas, com limite de Wilson ≥ 97% e SPRT (98% × 95%, α = β = 5%);
  - erro silencioso ≤ 0,1%;
  - 0 travamentos.
  - Meça com e sem `--with-expect`. O estado é zerado a cada rodada (`portal reset`), com as regras congeladas.
- **Comandos**:
  - grátis: `bun scripts/jev-bench.ts --sim --repeat 10 --seed 7 --with-expect`;
  - **pago, só com OK**: `bun scripts/jev-bench.ts --real --set teste2 --seeds <novas> --yes --max-real 140 --max-probes 1300 --label … --out docs/ade-ags/bench/….json`.
    - Sem `--yes`, pede para digitar `CONFIRMO`.
    - Precisa de uma aba do app (`AGS_HANDSHAKE`), mas **não** de reinstalar o app.
- Calibração: `scripts/jev-calibrate.ts` gera `docs/ade-ags/bench/calibracao-limites.md`.

## Pontos de atenção conhecidos
- O piloto **não tem allowlist de hosts**. Não documente uma como recurso do app sem implementá-la antes.
