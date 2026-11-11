//! Páginas HTML publicadas pelos agentes (o "HTML render" do T3 Code): um arquivo por página na pasta de dados e um
//! índice JSON com os metadados. Como o sidecar de tarefas agendadas, o índice é gravado por arquivo temporário e
//! `rename`, e um índice ilegível dá erro em vez de ser sobrescrito. Nenhuma página some sozinha: só a pessoa apaga.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Tamanho máximo de uma página publicada. Maior que isso não cabe no quadro isolado com folga.
pub const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
/// Limite do título, em caracteres (não em bytes).
pub const MAX_TITLE_CHARS: usize = 120;
const DIR_NAME: &str = "renders";
const INDEX_FILE: &str = "index.json";
const DEFAULT_TITLE: &str = "Página HTML";

/// Os metadados de uma página publicada. O HTML fica em `<id>.html`, na mesma pasta.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderPage {
    pub id: String,
    pub title: String,
    /// A aba que publicou a página (vazio quando não se sabe quem publicou).
    pub owner: String,
    /// A pasta do projeto da aba que publicou, para a lista filtrar por projeto.
    pub cwd: String,
    /// Milissegundos desde a época Unix, como em `util::now_ts_ms`.
    pub created_at: i64,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct IndexFile {
    #[serde(default)]
    pages: Vec<RenderPage>,
}

/// Uma gravação de índice por vez: publicar e apagar leem e reescrevem o mesmo arquivo.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// A pasta das páginas dentro da pasta de dados (`<ags>/renders`), a mesma que `ADE_AGS_DATA_DIR` aponta.
pub fn dir() -> Result<PathBuf, String> {
    crate::util::datadir::ags_home()
        .map(|home| home.join(DIR_NAME))
        .ok_or_else(|| "Pasta de dados indisponível".to_string())
}

/// O título que vai para o índice: sem espaços nas pontas, em uma linha, com limite e um padrão quando vazio. Pura.
pub fn clean_title(raw: &str) -> String {
    let one_line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = one_line.chars().take(MAX_TITLE_CHARS).collect();
    if title.is_empty() { DEFAULT_TITLE.to_string() } else { title }
}

/// Recusa HTML vazio ou acima do limite. Pura.
pub fn validate_html(html: &str) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err("A página está vazia: mande o HTML completo.".into());
    }
    if html.len() > MAX_HTML_BYTES {
        return Err(format!("A página passa de {} KiB. Reduza o HTML ou mande só o essencial.", MAX_HTML_BYTES / 1024));
    }
    Ok(())
}

/// Um id de página é um UUID (só hexadecimal e hífens). Isso impede que um id escape da pasta. Pura.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Publica uma página em `dir`. `owner` é a aba de quem publicou e `cwd` a pasta dela; `now` vem de quem chama.
/// As imagens locais embutidas vêm só da pasta `cwd` (ver `images.rs`), e a leitura delas fica fora do lock do índice.
pub fn publish_in(dir: &Path, owner: &str, cwd: &str, title: &str, html: &str, now: i64) -> Result<RenderPage, String> {
    validate_html(html)?;
    let projeto = Some(cwd).filter(|pasta| !pasta.trim().is_empty()).map(Path::new);
    let protegidas: Vec<PathBuf> = [Some(dir.to_path_buf()), crate::util::datadir::ags_home()].into_iter().flatten().collect();
    let html = super::images::embed(html, projeto, &protegidas, super::images::Limits::PADRAO)?;
    let _guard = INDEX_LOCK.lock().map_err(|_| "As páginas HTML estão travadas por outro processo.".to_string())?;
    let mut index = read_index(dir)?;
    let page = RenderPage {
        id: uuid::Uuid::new_v4().to_string(),
        title: clean_title(title),
        owner: owner.to_string(),
        cwd: cwd.to_string(),
        created_at: now,
        bytes: html.len() as u64,
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("Não consegui criar a pasta das páginas: {e}"))?;
    write_atomic(&html_path(dir, &page.id), html.as_bytes())?;
    index.pages.push(page.clone());
    write_index(dir, &index)?;
    Ok(page)
}

/// As páginas, da mais nova para a mais antiga. Com `owner`, só as que essa aba publicou.
pub fn list_in(dir: &Path, owner: Option<&str>) -> Result<Vec<RenderPage>, String> {
    let mut pages: Vec<RenderPage> = read_index(dir)?
        .pages
        .into_iter()
        .filter(|page| owner.is_none_or(|o| page.owner == o))
        .collect();
    pages.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(pages)
}

/// O HTML de uma página publicada. Só lê o que está no índice, e um id fora do formato é recusado antes de tocar em disco.
pub fn read_html_in(dir: &Path, id: &str) -> Result<String, String> {
    let path = known_html_path(dir, id)?;
    std::fs::read_to_string(path).map_err(|e| format!("A página sumiu da pasta de dados: {e}"))
}

/// O caminho do HTML de uma página que está no índice. Quem usa o caminho (abrir fora, ler) passa por aqui.
pub fn known_html_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    require_known(dir, id)?;
    Ok(html_path(dir, id))
}

/// Apaga uma página: o arquivo e a entrada do índice. A UI chama isto por clique; agentes não apagam.
pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    require_known(dir, id)?;
    let _guard = INDEX_LOCK.lock().map_err(|_| "As páginas HTML estão travadas por outro processo.".to_string())?;
    let mut index = read_index(dir)?;
    index.pages.retain(|page| page.id != id);
    write_index(dir, &index)?;
    match std::fs::remove_file(html_path(dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Não consegui apagar o arquivo da página: {e}")),
    }
}

/// O caminho do HTML de uma página (sem checar nada; quem chama já validou o id).
pub fn html_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.html"))
}

fn require_known(dir: &Path, id: &str) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err("Id de página inválido.".into());
    }
    if read_index(dir)?.pages.iter().any(|page| page.id == id) {
        Ok(())
    } else {
        Err(format!("Não há página HTML com o id {id}."))
    }
}

/// Lê o índice. Arquivo ausente é índice vazio; arquivo ilegível é erro, para nunca ser reescrito por cima.
fn read_index(dir: &Path) -> Result<IndexFile, String> {
    let path = dir.join(INDEX_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut index = serde_json::from_slice::<IndexFile>(&bytes)
                .map_err(|e| format!("O índice das páginas HTML está ilegível ({e}); não vou sobrescrevê-lo."))?;
            index.pages.retain(|page| is_valid_id(&page.id));
            Ok(index)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(IndexFile::default()),
        Err(e) => Err(format!("Não consegui ler o índice das páginas HTML: {e}")),
    }
}

fn write_index(dir: &Path, index: &IndexFile) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(INDEX_FILE), &bytes)
}

/// Grava em um arquivo temporário ao lado e troca pelo nome final, para que nenhuma leitura veja um arquivo pela metade.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("page");
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Não consegui gravar {}: {e}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Não consegui trocar {} pelo arquivo novo: {e}", path.display()));
    }
    Ok(())
}
