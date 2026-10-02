//! Las imágenes del canvas: se copian a `~/.controlcode/canvas-assets/` y el canvas guarda
//! solo su id.
//!
//! Si la imagen viviera dentro del canvas, cada vez que alguien moviera un nodo se
//! reescribiría el archivo entero con los megas de la imagen. Y guardar la RUTA original no
//! alcanza: el usuario la mueve o la borra y el canvas queda con un hueco.
//!
//! Solo imágenes, y se reconocen por su contenido y no por el nombre: un archivo llamado
//! `foto.png` que no empieza como un PNG no entra. El id lo genera la app (nunca viene del
//! usuario), así que no hay rutas que escapen de la carpeta.

use std::path::PathBuf;

use base64::Engine;

/// Cuánto puede pesar una imagen. Más es una foto sin reducir: pesaría en cada apertura.
pub const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl Format {
    fn ext(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpg",
            Format::Gif => "gif",
            Format::Webp => "webp",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::Gif => "image/gif",
            Format::Webp => "image/webp",
        }
    }

    fn from_ext(ext: &str) -> Option<Format> {
        match ext {
            "png" => Some(Format::Png),
            "jpg" => Some(Format::Jpeg),
            "gif" => Some(Format::Gif),
            "webp" => Some(Format::Webp),
            _ => None,
        }
    }
}

/// Qué imagen es, por sus primeros bytes.
pub fn sniff(bytes: &[u8]) -> Option<Format> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(Format::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(Format::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(Format::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(Format::Webp)
    } else {
        None
    }
}

/// Un id válido: 32 hex y una extensión conocida. Es lo único que se acepta al leer, así
/// que no hay forma de pedir otra ruta.
pub fn parse_id(id: &str) -> Option<(String, Format)> {
    let (stem, ext) = id.split_once('.')?;
    let ok = stem.len() == 32 && stem.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
    ok.then(|| Format::from_ext(ext).map(|f| (stem.to_string(), f))).flatten()
}

fn dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("No se encontró la carpeta del usuario")?.join(".controlcode").join("canvas-assets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Valida y decodifica lo que manda la pantalla (base64). Devuelve los bytes y su formato.
pub fn decode(data: &str) -> Result<(Vec<u8>, Format), String> {
    // El límite en el texto antes de decodificar: base64 pesa un tercio más.
    if data.len() > MAX_BYTES / 3 * 4 + 16 {
        return Err(format!("A imagem passa de {} MB.", MAX_BYTES / 1024 / 1024));
    }
    let payload = data.split_once(',').map(|(_, rest)| rest).unwrap_or(data);
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload.trim()).map_err(|_| "A imagem não é válida.".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("A imagem passa de {} MB.", MAX_BYTES / 1024 / 1024));
    }
    let format = sniff(&bytes).ok_or("Só se aceitam imagens PNG, JPEG, GIF ou WebP.")?;
    Ok((bytes, format))
}

#[tauri::command]
pub fn canvas_asset_save(data: String) -> Result<String, String> {
    let (bytes, format) = decode(&data)?;
    let id = format!("{}.{}", uuid::Uuid::new_v4().simple(), format.ext());
    std::fs::write(dir()?.join(&id), bytes).map_err(|e| e.to_string())?;
    Ok(id)
}

/// La imagen como `data:` URL, que es lo que la pantalla puede mostrar sin abrir nada más.
#[tauri::command]
pub fn canvas_asset_load(id: String) -> Result<String, String> {
    let (_, format) = parse_id(&id).ok_or("Imagem desconhecida.")?;
    let bytes = std::fs::read(dir()?.join(&id)).map_err(|_| "A imagem não está mais no disco.".to_string())?;
    Ok(format!("data:{};base64,{}", format.mime(), base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod test {
    use super::*;

    const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    #[test]
    fn reconoce_las_imagenes_por_su_contenido() {
        assert_eq!(sniff(&PNG), Some(Format::Png));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Some(Format::Jpeg));
        assert_eq!(sniff(b"GIF89a\x01\x00"), Some(Format::Gif));
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some(Format::Webp));
        assert_eq!(sniff(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None, "un SVG puede llevar scripts");
        assert_eq!(sniff(b"MZ\x90\x00 un exe llamado foto.png"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn decodifica_con_o_sin_el_prefijo_data_url() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(PNG);
        assert_eq!(decode(&b64).unwrap().1, Format::Png);
        assert_eq!(decode(&format!("data:image/png;base64,{b64}")).unwrap().1, Format::Png);
        assert!(decode("%%%no es base64%%%").is_err());
        let not_image = base64::engine::general_purpose::STANDARD.encode(b"hola mundo, no soy una imagen");
        assert!(decode(&not_image).unwrap_err().contains("PNG"));
    }

    #[test]
    fn se_rechaza_lo_demasiado_grande() {
        let mut big = PNG.to_vec();
        big.resize(MAX_BYTES + 1, 0);
        let b64 = base64::engine::general_purpose::STANDARD.encode(big);
        assert!(decode(&b64).unwrap_err().contains("MB"));
    }

    #[test]
    fn el_id_solo_admite_32_hex_y_una_extension_conocida() {
        let ok = format!("{}.png", "a".repeat(32));
        assert_eq!(parse_id(&ok).map(|(_, f)| f), Some(Format::Png));
        for bad in [
            "../../etc/passwd",
            "..\\..\\x.png",
            &format!("{}.exe", "a".repeat(32)),
            &format!("{}.png", "A".repeat(32)),
            &format!("{}.png", "a".repeat(31)),
            "a.png",
            "",
        ] {
            assert!(parse_id(bad).is_none(), "{bad}");
        }
    }
}
