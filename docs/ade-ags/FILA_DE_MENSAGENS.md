# Fila de mensagens entre agentes

Toda mensagem de agente para agente (`peer tell`, `peer ask` com o destino ocupado, `peer deliver`,
o briefing do `peer role` e o aviso do `ci watch`) tem um id e um registro no SQLite. A fila sobrevive
ao reinício do app, e o usuário vê e mexe no que está esperando.

## Tabela `peer_messages`

Criada por `peer_queue::store::migrate` (aditiva, sem subir `user_version`).

| Coluna | O quê |
|---|---|
| `id` | id da mensagem (`messageId` nas respostas da CLI/MCP) |
| `client_id` | o `--id` de quem mandou; único por `(from_tab_id, client_id)` |
| `kind` | `tell`, `ask`, `handoff`, `role`, `notice` |
| `from_tab_id`/`from_name`, `to_tab_id`/`to_name` | remetente e destino |
| `text` | o texto do remetente, sem cabeçalho (é o que o usuário edita) |
| `raw`, `reply` | sem cabeçalho (`--raw`); cabeçalho de pergunta (`ask` direto) |
| `state` | ver abaixo |
| `position`, `force_now` | ordem na fila do destino; "enviar agora" |
| `attempts`, `created_at`, `updated_at`, `delivered_at`, `edited_at`, `note` | recibo |

## Estados

```text
queued ──► delivering ──► delivered
  │             └───────► unconfirmed ──┐
  ├──► cancelled  (usuário/remetente)    │ reenvio com o mesmo --id
  └──► expired    (aba fechada / velha) ─┴──► queued
```

- `queued → delivering` é uma só escrita (`store::claim`): duas threads, ou o app depois de um
  reinício, nunca digitam a mesma mensagem duas vezes.
- O texto é lido do banco na hora da entrega: vale a versão editada.
- Registros resolvidos saem depois de 7 dias; a fila nunca é apagada.

## Idempotência

- **Com `--id`** (`peer tell/ask/deliver`; `id` nas tools MCP `peer_tell`/`peer_deliver`): o mesmo id é a
  mesma mensagem. Na fila, sendo digitada, entregue ou cancelada, a resposta traz `duplicate: true,
  repeat: true` e o estado, e nada é digitado. Se ela ficou `unconfirmed` ou `expired`, o reenvio a
  põe de novo na fila (o app já tinha dito que ela não chegou). O mesmo id para outro destino é erro.
  No `peer deliver`, o mesmo id não grava outra entrega em `mission_handoffs`.
- **Sem `--id`**: o dedupe de antes, agora no banco — mesmo destino, mesmo texto, mesmo remetente
  (com `--raw`, qualquer remetente), há menos de 10 min, em `queued/delivering/delivered`. O `ask`
  direto (destino livre) não entra nesse dedupe, como antes.

## Entrega

- `deliver_now_or_queue`: registra, e se a mensagem é a primeira da fila e o destino se aquieta em
  3 s, digita já. Senão liga o entregador do destino. A resposta mantém `sent/queued/unconfirmed/
  duplicate` e ganha `messageId`, `state` e `cancelled`.
- Entregador (`ipc/commands/peer_queue.rs::run_worker`): um por destino, com o `delivery_lock`.
  Espera o destino ficar quieto (em fatias de 3 s, para pegar "enviar agora", reordenação e
  cancelamento), no máximo 15 min desde a criação da mensagem; depois digita a primeira da fila.
  Aba fechada: o que esperava vira `expired`. Aba sem terminal por 2 min: a fila fica e o entregador
  sai (uma mensagem nova ou "enviar agora" o liga de novo).
- O aviso de atraso (`stale_note`, ≥ 20 s) vai em toda mensagem que esperou, menos nas `--raw`.

## Arranque do app

`start_resume` (em `app/run.rs`, fora do modo headless): `delivering` vira `unconfirmed` (não se sabe
se chegou, então não se digita de novo); `queued` de aba que não existe mais, ou com mais de 1 h, vira
`expired`; o resto volta a andar, com o aviso de atraso.

## Interface e CLI

- Selo "N na fila" na aba do terminal (`TabItem`) e no cabeçalho do nó do canvas (`CanvasView`).
  Clicar abre a lista: tipo, de quem, há quanto tempo, primeira linha; subir/descer, editar, enviar
  agora e cancelar (com confirmação). Atualiza pelo evento `cc-peer-queue`.
- Comandos Tauri: `peer_queue_counts`, `peer_queue_list`, `peer_queue_edit`, `peer_queue_move`,
  `peer_queue_cancel`, `peer_queue_send_now`.
- `ags peer queue [list]` (o que você mandou e espera) e `ags peer queue cancel <id>` (só as suas).
