# Fixtures ai-memory 3.3.0

Saídas reais do binário oficial macOS arm64, capturadas no ensaio isolado da Fase 0. Nenhum binário é executado pelos testes. Origem da captura: release `v3.3.0` de `akitaonrails/ai-memory`; pacote SHA256 `c583bb79691c97fb6df3feb775a9a4d677be1bd0b671208d41e0b03699c1e0b6`.

UUIDs, timestamps, portas e caminhos temporários foram substituídos por valores fixos; contagens e metadados são os da captura. `*-empty` representam a base vazia. A página e o bastão populados contêm dados sintéticos criados exclusivamente nessa base de teste. As estruturas extras do status permanecem nas fixtures para provar a tolerância do DTO a campos desconhecidos.

`sessions-briefing.json` é o conteúdo JSON real de `memory_briefing` via bridge da mesma captura, com `recent_sessions: []`. `sessions-briefing-populated.json` é uma **derivação sintética** desse objeto para testar uma sessão e campo futuro; não é uma captura populada real.
