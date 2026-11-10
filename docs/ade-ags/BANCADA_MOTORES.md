# Bancada de testes: fake de agente, replay de protocolo e mock de `invoke`

Três ferramentas de teste para o que fala com os agentes sem TUI e para o front. Nenhuma abre processo, gasta cota ou espera relógio de verdade. Vieram dos pontos 4, 26 e 27 da análise do `deepseek-ai/deepseek-harness` (MIT).

| Ferramenta | Onde | Para quê |
|---|---|---|
| Fake de agente com falhas roteirizadas | `src-tauri/src/conversa/bancada.rs` | tocar um roteiro (stall, JSON cortado, queda, cota, `max_tokens`, aprovação, pergunta) nos mapeadores reais dos três protocolos |
| Replay de protocolo (`ade-replay` v2) | `src-tauri/src/conversa/replay_protocolo.rs` + `conversa/fixtures/protocolo/` | transcript JSON gravado ou sintetizado, com snapshot e um oráculo que o refresh não reescreve |
| Mock de `invoke` por nome | `src/test/invokeMock.ts` | o teste do front falha se uma chamada Tauri ficou sem resposta preparada |

Rodar:

```
cd src-tauri && cargo test --lib conversa::test_bancada
bunx vitest run src/test
```

`ags test affected` já pega os dois lados: um arquivo em `src-tauri/src/conversa/` (fixtures incluídas) roda `cargo test --lib -- conversa::`; `src/test/` roda o vitest relacionado.

## 1. Fake de agente (`bancada.rs`)

O fake **não é um binário**: os motores (`claude.rs`, `codex.rs`, `opencode.rs`) acham o programa no PATH e prendem a sessão ao `AppHandle`, e trocar isso mexeria no código de produção. A bancada fica um degrau acima do processo:

1. `tocar(&Roteiro)` escreve as linhas que `claude -p` (stream-json), `codex app-server` ou o ACP (`opencode acp`) mandariam no stdout, cada uma com o instante num relógio falso.
2. `rodar(protocolo, &saidas)` faz com elas o que o `read_loop` + `dispatch` de cada motor faz:
   - pula a linha que não é JSON;
   - passa o resto por `claude_map::Mapper`, `codex_map::{items_of, delta_of, ask_of, turn_end}` ou `opencode_map::Mapper`;
   - fecha o turno de um processo que caiu com `turn::dropped` + `turn::stderr_reason` (no Codex, sem o stderr, como o `codex.rs`).
3. O `Resultado` traz a sessão, a timeline (o item atualizado fica no lugar, como no banco), os pedaços, os pedidos, os filhos (`Task` e `SubItem`, fora da timeline), o fim do turno, as linhas puladas e o maior silêncio. Traz também as classes de erro que o resto do app usa:
   - `classe()`: `runs::failure::classify`;
   - `classe_para_o_pool()`: o filtro do `pool::after_turn` (interrupção não conta);
   - `falha_de_retomada()`: `resume::classify`, com a recusa do Codex como `Gone`, como em `codex::resume_failure`.

### Passos

| `passo` | Campos | Claude | Codex | ACP |
|---|---|---|---|---|
| `sessao` | `id` | `system/init` | resposta do `thread/resume` | respostas de `initialize` e `session/new` |
| `recusa` | `mensagem` | `result` de erro antes do `init` | erro na resposta do `thread/resume` | erro na resposta do `session/new` |
| `texto` | `texto`, `pedacos` | `stream_event` + `assistant` | `item/agentMessage/delta` + `item/completed` | `agent_message_chunk` |
| `ferramenta` | `nome`, `entrada`, `saida`, `erro` | `tool_use` + `tool_result` | `commandExecution` | `tool_call` + `tool_call_update` |
| `aprovacao` | `comando` | `control_request` `can_use_tool` | `item/commandExecution/requestApproval` | `session/request_permission` |
| `pergunta` | `pergunta`, `opcoes` | `AskUserQuestion` | `item/tool/requestUserInput` | não existe (recusa) |
| `stall` | `ms` | só o relógio anda | ← | ← |
| `jsonMalformado` | — | linha cortada | ← | ← |
| `desconecta` | `stderr` | o processo fecha | ← | ← |
| `cota` | `mensagem` | `result` com `is_error` | `error` + `turn/completed` `failed` | erro na resposta do `session/prompt` |
| `maxTokens` | — | `stop_reason: max_tokens` (sintetizado) | `failed` com `max_output_tokens` (sintetizado) | `stopReason: max_tokens` |
| `interrompido` | — | `terminal_reason: aborted_by_user` | `interrupted` | `stopReason: cancelled` |
| `fim` | — | `result` sem erro | `completed` | `end_turn` |

`agy-stream` e `cursor-stream` não entram nesta tabela. O roteiro sintetizado recusa os dois: o replay lê um transcript. O agy usa o laço do `agy.rs` (uma linha JSON por vez, sem prazo). O Cursor usa o `read_turn` do motor: se o próximo `atMs` passa de `quiet_after`, a fonte devolve silêncio e o turno fecha, sem relógio de parede. O fim da lista é EOF. Os frames de verdade vêm da captura, não daqui.

Um silêncio maior que `PRAZO_PEDIDO_MS` (60 s) **antes** da sessão abrir vira o "não respondeu" do motor, que a retomada trata como prazo. Silêncio no meio do turno só fica medido em `silencio_max_ms`, porque os motores não têm prazo de turno: quem trata o agente parado é o Vigia.

### Roteiros em fixture

`src-tauri/src/conversa/fixtures/roteiros/<id>.json`:

```json
{
  "id": "claude-cota-no-meio",
  "titulo": "…",
  "roteiro": { "protocolo": "claude-stream", "passos": [ { "passo": "sessao", "id": "sessao-a" }, { "passo": "cota", "mensagem": "You've hit your limit · resets 3pm" } ] },
  "espera": { "fim": "erro", "classe": "rate_limited" }
}
```

O teste `os_roteiros_das_fixtures_cumprem_o_que_prometem` lê a pasta inteira.

As chaves do `espera` (as mesmas dos `checks` do oráculo do replay) são estas. Uma chave fora da lista falha a leitura.

| Chave | Confere |
|---|---|
| `fim` | `ok`, `erro`, `interrompido`, `caiu` ou `aberto` |
| `erroContem` | trecho do erro do turno |
| `classe`, `classeParaOPool` | `rate_limited`, `auth`, `model`, `balance`, `other` ou `nenhuma` |
| `retomada` | `gone`, `transient`, `timeout`, `fatal` ou `abriu` |
| `sessao` | o id aberto (aceita `{{session:N}}`) |
| `pedidos` | os tipos, em ordem (`command`, `fileChange`, `question`) |
| `ferramentas` | `Nome:status`, em ordem (`Bash:done`, `Edit:error`) |
| `tipos` | o tipo de cada item da timeline, em ordem (`assistant`, `tool`, `usage`) |
| `filhos` | eventos de filho, em ordem: `task:<id>:<op>` ou `subitem:<pai>:<tipo do item>` |
| `pedidosPendentes` | os tipos dos pedidos que ainda estavam sem resposta nem cancelamento no fim da leitura |
| `textoContem` | trecho da fala do agente |
| `ignoradas` | quantas linhas não eram JSON |
| `silencioMinMs` | o maior silêncio foi pelo menos isto |

### Modo aleatório

`Roteiro::aleatorio(protocolo, seed, max_passos)` sorteia um turno com um gerador próprio (splitmix64), igual em qualquer máquina. O teste `roteiros_sorteados_nunca_quebram_o_motor` roda 300 sementes por protocolo e confere propriedades:
- a sessão abre;
- as linhas puladas são as cortadas;
- cada aprovação ou pergunta vira um pedido;
- nenhum item se repete;
- a cota chega ao pool como limite;
- parar não troca de conta;
- a queda fecha o turno.

A falha diz a semente; para rodar só ela:

```
BANCADA_SEED=42 cargo test --lib roteiros_sorteados
```

### O que os testes da bancada cobrem

| Alvo | Testes (`conversa/test_bancada.rs`) |
|---|---|
| Os três motores | `mod fake`: o mesmo turno nos três protocolos, deltas com o id do item final, linha cortada, queda com o stderr, pedidos, interrupção, `max_tokens`, silêncio no relógio falso |
| `resume.rs` | `mod retomada`: `open_resuming` com cada tentativa abrindo uma sessão pela bancada (recusa = sessão nova com aviso; silêncio de 61 s = prazo, sessão mantida; queda = retentativa com pausa registrada) |
| Pool de contas | `mod pool`: a cota de cada motor chega ao `pool::decide` como limite e com a hora de renovação lida da mensagem; `move_account` tira a sessão da conta A; o 2º turno na conta B abre outra sessão e a segunda cota não encadeia troca |

### O que a bancada já achou (não corrigido aqui)

- **O Claude não avisa o turno cortado em `max_tokens`.** O `claude_map` não lê o `stop_reason` da mensagem, e o turno acaba como "ok". O formato do `max_tokens` do Claude na bancada é sintetizado: confirmar com uma gravação antes de corrigir. Teste: `interrupcao_nao_e_erro_e_max_tokens_e_so_no_acp_e_no_codex`.
- **A queda do Codex chega à tela sem o motivo.** O `codex.rs` manda o stderr só para o log, e o `closed` fecha o turno com `turn::dropped(killed, None, "Codex")`. O Claude e o OpenCode mostram a última linha do stderr que não é aviso. Testes: `a_queda_no_meio_do_turno_vira_erro_com_o_motivo_do_stderr` e a fixture `codex-comando-falha-e-queda`.
- **O Codex que esgota a conta não aciona o pool.** O `codex.rs` fecha o turno em `on_notification("turn/completed")` sem chamar `pool::after_turn`, enquanto o Claude (`claude.rs`) e os motores de `turn::finish` (OpenCode, Antigravity) chamam. A bancada mostra que o erro do Codex classifica como limite (`a_cota_de_qualquer_motor_chega_ao_pool…`), mas o motor real não leva esse erro ao pool.

## 2. Replay de protocolo (`ade-replay` v2)

O v1 ([REPLAY_TESTES.md](./REPLAY_TESTES.md)) toca bytes de PTY nos detectores de tela. O v2 toca **linhas JSON do stdio** no motor de bancada. Cada fixture são dois arquivos em `src-tauri/src/conversa/fixtures/protocolo/`.

`<id>.json`: o transcript e o snapshot.

```json
{
  "format": "ade-replay", "version": 2, "kind": "protocolo",
  "id": "codex-comando-falha-e-queda", "agent": "codex", "protocol": "codex-app-server",
  "title": "…", "origin": { "kind": "synthesized", "basis": "…" },
  "transcript": [
    { "atMs": 0,   "in":  { "id": 1, "method": "thread/resume", "params": { "threadId": "{{session:1}}" } } },
    { "atMs": 120, "out": { "id": 1, "result": { "thread": { "id": "{{session:1}}" } } } },
    { "atMs": 130, "raw": "{\"method\":\"item/comp" },
    { "atMs": 9400, "close": { "stderr": "Error: Transport error" } }
  ],
  "expected": { "…": "o snapshot, gravado pelo refresh" }
}
```

`<id>.oracle.json`: escrito à mão, com ao menos um check.

```json
{ "checks": [ { "label": "a queda fecha o turno", "expect": { "fim": "caiu", "erroContem": "Transport error" } } ] }
```

| Campo | O quê |
|---|---|
| `transcript[]` | em ordem de `atMs`. Cada entrada tem exatamente um destes: `out` (linha do agente), `raw` (linha que não é JSON), `in` (o que o app mandou; só documenta, o motor não lê) ou `close` (o processo fechou) |
| placeholders | `{{session:N}}` (uuid com o N dentro), `{{cwd}}`, `{{home}}`. Outro tipo é erro |
| `expected` | o snapshot: sessão, itens, `tipos`, deltas, pedidos, `pedidosPendentes`, `filhos`, fim, queda, avisos, linhas puladas. Gravado com os placeholders de volta no lugar |

### Modos (`ADE_REPLAY_MODE`)

| Modo | Faz |
|---|---|
| `replay` (padrão) | guard → oráculo → compara o snapshot. Snapshot diferente falha com os dois lados |
| `refresh` | guard → oráculo → **regrava só o `expected`** do `<id>.json`. Se o oráculo falha, não grava nada: o refresh não aprova regressão |
| `record` | cria `<id>.json` de um `.jsonl` gravado e um `<id>.oracle.json` vazio, que reprova até ser escrito |

```
ADE_REPLAY_MODE=refresh cargo test --lib replay_protocolo
ADE_REPLAY_MODE=record ADE_REPLAY_SOURCE=/caminho/saida.jsonl ADE_REPLAY_ID=claude-x \
  ADE_REPLAY_PROTOCOL=claude-stream ADE_REPLAY_CWD=/caminho/do/projeto \
  cargo test --lib gravar_fixture_de_protocolo
```

No `record`:
- os uuids viram `{{session:N}}`, na ordem em que aparecem;
- o `ADE_REPLAY_CWD` vira `{{cwd}}`, e o `HOME` vira `{{home}}`;
- um texto que parece ter segredo (`memory::agent::looks_like_secret`) não é salvo;
- cada linha ganha `atMs` de 10 em 10. Para o Claude, o Codex, o ACP e o agy isso não muda o fim do turno.

Para gravar o Cursor ou o Antigravity, o protocolo é `cursor-stream` ou `agy-stream` e o agente é `cursor` ou `antigravity`. O `.jsonl` é o stdout, uma linha por evento, capturado à mão. Não use estes testes para chamar a CLI.

```
ADE_REPLAY_MODE=record ADE_REPLAY_SOURCE=/caminho/saida.jsonl ADE_REPLAY_ID=cursor-x \
  ADE_REPLAY_PROTOCOL=cursor-stream ADE_REPLAY_AGENT=cursor ADE_REPLAY_CWD=/caminho/do/projeto \
  cargo test --lib gravar_fixture_de_protocolo
```

O `record` do Cursor deixa as linhas a 10 ms uma da outra, intervalo menor que qualquer `quiet_after`. Assim o silêncio não dispara. Antes do `refresh`, ajuste o `atMs` pelo `timestamp_ms` da linha (a diferença para a primeira). Sem esse ajuste, a fixture não prova o fim de turno por prazo. O agy não tem esse prazo: o `atMs` de 10 em 10 serve.

O `.jsonl` vem de rodar o agente à mão, com a cota e a conta da pessoa, fora dos testes: os testes nunca chamam um agente de verdade. Leia a fixture inteira antes de commitar.

### Guard

A fixture é recusada quando:
- tem um placeholder de tipo desconhecido;
- não tem oráculo, ou o oráculo não tem nenhum check;
- uma entrada tem mais de um tipo ou está fora de ordem;
- **a timeline (ou um filho) tem uma ferramenta `Other` fora da lista do protocolo.** Claude, Codex e ACP não aceitam nenhum `Other`. O agy aceita o nome `denied` (a ação negada que o mapeador grava assim). O Cursor aceita, por enquanto, só o nome `mcp`, que existe para o guard ter o que deixar passar; não é um catálogo do provider. Um nome novo derruba a fixture até entrar na lista. Mapeie a ferramenta em `canal::timeline` antes de gravar, quando ela for uma ferramenta de verdade.

### Fixtures atuais

Todas sintetizadas.

| id | Cobre |
|---|---|
| `claude-ferramenta-aprovacao-e-cota` | `Read` e `Bash`, linha cortada, aprovação, cota com hora de renovação |
| `codex-comando-falha-e-queda` | `thread/resume`, comando com saída ≠ 0, `error` com `willRetry`, aprovação de arquivo, queda com stderr |
| `acp-pedido-e-max-tokens` | raciocínio, fala em pedaços, `request_permission` de edição, diff, `max_tokens` |

## 3. Mock de `invoke` (front)

`src/test/invokeMock.ts`:

```ts
import { invokeMock, useInvokeMock } from "@/test/invokeMock";
vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
useInvokeMock(); // reset antes de cada teste, assertNoUnmatched() depois

invokeMock.on("peer_queue_list", () => queue);           // toda chamada
invokeMock.once("peer_queue_cancel", ({ id }) => ({ id })); // só a próxima (vem antes do `on`)
expect(invokeMock.calls("peer_queue_cancel")).toEqual([{ id: 1 }]);
```

- A resposta é um valor ou uma função dos argumentos. A função pode ser `async` ou lançar, e aí vira a rejeição do `invoke`, como um erro do backend.
- Uma chamada sem resposta rejeita na hora **e** reprova no teardown, mesmo que o código engula o erro.
- Uma resposta `once` que ninguém consumiu também reprova: a chamada que o teste esperava sumiu.

Adotado como exemplo em `src/features/forge/tests/reviewGuideStore.test.ts` e `src/features/peerQueue/tests/badge.test.tsx`. Os outros testes continuam com `vi.fn()`; migre quando mexer neles.

## Limites

- A bancada imita o laço de leitura de cada motor, mas não executa `claude.rs`, `codex.rs` nem `opencode.rs`. Pipes, `kill`, a escrita no stdin, a fila de envio e as respostas da pessoa (`answer_of`) ficam de fora. Uma mudança só no `dispatch` de um motor precisa ser repetida no `Motor` da bancada.
- Os formatos do fake e das fixtures são sintetizados a partir do código e dos testes existentes: não foram medidos contra as CLIs atuais. Uma gravação com `record` confirma ou derruba cada um.
- O Vigia do chat e a frota headless ainda não usam a bancada.
