//! Sobreposição de áreas: duas tarefas que mexem no mesmo arquivo ou pasta devem ser serializadas.
//! Uma área é um caminho relativo (`src/features/chat`), uma pasta com glob (`src/features/chat/**`) ou um arquivo.
//! Só avisa e sugere; nunca bloqueia sozinha (ver `docs/agentes/ORQUESTRACAO.md`).

/// O caminho da área sem o que é glob: `./src\\a/**/*.ts` vira `src/a`. Vazio quando a área é a raiz inteira.
pub fn normalize(area: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let unified = area.trim().replace('\\', "/");
    for part in unified.split('/') {
        if part.contains('*') || part.contains('?') || part.contains('[') {
            break;
        }
        if part.is_empty() || part == "." {
            continue;
        }
        parts.push(part);
    }
    parts.join("/")
}

/// Uma contém a outra (ou são iguais), por segmento de caminho: `src/a` cobre `src/a/b.ts`, mas não `src/ab`.
fn covers(outer: &str, inner: &str) -> bool {
    outer.is_empty() || inner == outer || inner.starts_with(&format!("{outer}/"))
}

pub fn parse(raw: &[String]) -> Vec<String> {
    let mut seen = Vec::new();
    for item in raw.iter().flat_map(|text| text.split(',')) {
        let text = item.trim();
        if !text.is_empty() && !seen.iter().any(|s: &String| s == text) {
            seen.push(text.to_string());
        }
    }
    seen
}

/// As partes de `mine` que se sobrepõem a `theirs` (a mais estreita das duas, como o orquestrador declarou).
pub fn shared(mine: &[String], theirs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in mine {
        let na = normalize(a);
        for b in theirs {
            let nb = normalize(b);
            if covers(&na, &nb) || covers(&nb, &na) {
                let narrow = if covers(&na, &nb) { b } else { a };
                if !out.contains(narrow) {
                    out.push(narrow.clone());
                }
            }
        }
    }
    out
}
