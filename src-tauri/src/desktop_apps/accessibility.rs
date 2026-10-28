//! Drive only Gemini's visible, accessible controls. This stays inside the signed desktop app
//! and its current Google login; it does not read browser profiles, cookies, tokens, or endpoints.
use std::{thread, time::{Duration, Instant}};
use windows::{
    core::BSTR,
    Win32::{
        Foundation::HWND,
        System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
        UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement, IUIAutomationInvokePattern,
            IUIAutomationTextPattern, IUIAutomationValuePattern, TreeScope_Descendants,
            UIA_ButtonControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
            UIA_InvokePatternId, UIA_TextPatternId, UIA_ValuePatternId,
        },
    },
};

struct ComApartment;
impl ComApartment {
    fn mta() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
            .map_err(|e| format!("Windows accessibility initialization failed: {e}"))?;
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) { unsafe { CoUninitialize() } }
}

fn text(value: BSTR) -> String { String::from_utf16_lossy(&value) }

fn elements(automation: &IUIAutomation, root: &IUIAutomationElement) -> Result<Vec<IUIAutomationElement>, String> {
    unsafe {
        let condition: IUIAutomationCondition = automation.CreateTrueCondition().map_err(|e| e.to_string())?;
        let all = root.FindAll(TreeScope_Descendants, &condition)
            .map_err(|e| format!("Could not inspect Gemini controls: {e}"))?;
        let count = all.Length().map_err(|e| e.to_string())?.clamp(0, 10_000);
        (0..count).map(|i| all.GetElement(i).map_err(|e| e.to_string())).collect()
    }
}

fn current_name(element: &IUIAutomationElement) -> String {
    unsafe { element.CurrentName().map(text).unwrap_or_default() }
}

fn is_placeholder(value: &str) -> bool {
    value.trim().is_empty()
        || ["peça ao gemini", "ask gemini", "ask a question", "insira um comando para o gemini"]
            .iter()
            .any(|p| value.trim().eq_ignore_ascii_case(p))
}

fn marker_from_ade_draft(value: &str, prompt: &str) -> Option<String> {
    const INSTRUCTION: &str = "Finish your answer with this exact marker on its own final line: ";
    const PREFIX: &str = "ADE_GEMINI_DONE_";
    let (draft_prompt, marker) = value.rsplit_once(INSTRUCTION)?;
    let draft_prompt = draft_prompt.trim_end_matches(['\r', '\n']);
    let marker = marker.trim();
    let nonce = marker.strip_prefix(PREFIX)?;
    (same_visible_text(draft_prompt, prompt) && nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| marker.to_string())
}

fn find_composer(all: &[IUIAutomationElement]) -> Result<(IUIAutomationElement, IUIAutomationValuePattern, String), String> {
    let mut candidates = Vec::new();
    for element in all {
        let is_edit = unsafe { element.CurrentControlType().is_ok_and(|ty| ty == UIA_EditControlTypeId) };
        if !is_edit || !unsafe { element.CurrentIsEnabled().is_ok_and(|v| v.0 != 0) } { continue; }
        let name = current_name(element).to_lowercase();
        let value = unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) };
        let Ok(value) = value else { continue; };
        let is_gemini_composer = name.contains("gemini") || name.contains("comando") || name.contains("prompt");
        let Ok(current_value) = (unsafe { value.CurrentValue() }) else { continue; };
        let current = text(current_value);
        if is_gemini_composer { candidates.push((element.clone(), value, current)); }
    }
    if candidates.len() != 1 {
        return Err(format!("Could not identify a unique Gemini message box through Windows accessibility (found {}).", candidates.len()));
    }
    let (element, value, current) = candidates.pop().unwrap();
    if !unsafe { value.CurrentIsReadOnly().is_ok_and(|v| v.0 == 0) } {
        return Err("Gemini's message box is read-only right now.".into());
    }
    Ok((element, value, current))
}

fn invoke_send_button(all: &[IUIAutomationElement]) -> Result<(), String> {
    let terms = ["send", "enviar", "envoyer", "senden", "invia", "送信", "שלח", "إرسال"];
    let mut candidates = Vec::new();
    for element in all {
        if !unsafe { element.CurrentControlType().is_ok_and(|ty| ty == UIA_ButtonControlTypeId) } { continue; }
        let name = current_name(element);
        let normalized = name.to_lowercase();
        if terms.iter().any(|term| normalized.contains(term))
            && unsafe { element.CurrentIsEnabled().is_ok_and(|v| v.0 != 0) }
        {
            if let Ok(invoke) = unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) } {
                candidates.push((element.clone(), name, invoke));
            }
        }
    }
    if candidates.is_empty() {
        return Err("Gemini's send button is not exposed by Windows accessibility in this app version.".into());
    }
    // Prefer the shortest exact action label over a surrounding tools/menu button.
    candidates.sort_by_key(|(_, name, _)| {
        let normalized = name.to_lowercase();
        let exact = terms.iter().any(|term| normalized.trim() == *term);
        (!exact, name.chars().count())
    });
    unsafe { candidates[0].2.Invoke() }
        .map_err(|e| format!("Windows could not invoke Gemini's send button: {e}"))
}

fn page_text(automation: &IUIAutomation, root: &IUIAutomationElement) -> Result<String, String> {
    let all = elements(automation, root)?;
    let mut best = String::new();
    for element in &all {
        if !unsafe { element.CurrentControlType().is_ok_and(|ty| ty == UIA_DocumentControlTypeId) } { continue; }
        let name = current_name(element).to_lowercase();
        if !name.contains("gemini") && !name.contains("google") { continue; }
        if let Ok(pattern) = unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) } {
            if let Ok(range) = unsafe { pattern.DocumentRange() } {
                if let Ok(value) = unsafe { range.GetText(200_000) } {
                    let candidate = text(value);
                    if candidate.len() > best.len() { best = candidate; }
                }
            }
        }
    }
    if !best.is_empty() { return Ok(best); }

    // Chromium's accessibility provider exposes paragraph text as names on some app versions.
    let mut names = Vec::new();
    for element in &all {
        let name = current_name(element);
        if !name.trim().is_empty() { names.push(name); }
    }
    if names.is_empty() {
        let _ = automation;
        Err("Gemini's response text is not exposed by Windows accessibility in this app version.".into())
    } else {
        Ok(names.join("\n"))
    }
}

fn normalized_map(raw: &str) -> (String, Vec<(usize, usize)>) {
    let mut output = String::new();
    let mut spans = Vec::new();
    let mut pending_space: Option<(usize, usize)> = None;
    for (start, ch) in raw.char_indices() {
        let end = start + ch.len_utf8();
        if ch.is_whitespace() {
            if !output.is_empty() {
                pending_space = Some((pending_space.map_or(start, |s| s.0), end));
            }
            continue;
        }
        if let Some(span) = pending_space.take() {
            output.push(' ');
            spans.push(span);
        }
        output.push(ch);
        spans.push((start, end));
    }
    (output, spans)
}

fn same_visible_text(left: &str, right: &str) -> bool {
    normalized_map(left).0 == normalized_map(right).0
}

fn wait_until_value_matches(value: &IUIAutomationValuePattern, expected: &str) -> bool {
    // Chromium-backed inputs often update asynchronously after UIA SetValue returns.
    // Poll the live value instead of treating the first stale read as a rejected draft.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let read_back = unsafe { value.CurrentValue().map(text).unwrap_or_default() };
        if same_visible_text(&read_back, expected) { return true; }
        if Instant::now() >= deadline { return false; }
        thread::sleep(Duration::from_millis(120));
    }
}

fn extract_response(raw: &str, submitted: &str, marker: &str) -> Option<String> {
    let (normalized, spans) = normalized_map(raw);
    let (needle, _) = normalized_map(submitted);
    let prompt_start = normalized.rfind(&needle)?;
    let prompt_start_char = normalized[..prompt_start].chars().count();
    let prompt_last = prompt_start_char + needle.chars().count().checked_sub(1)?;
    let body_start = spans.get(prompt_last)?.1;
    let marker_start = raw.rfind(marker)?;
    if marker_start <= body_start { return None; }
    let mut response = raw[body_start..marker_start].trim().to_string();
    for label in ["Gemini\n", "Gemini\r\n", "Resposta do Gemini\n", "Resposta do Gemini\r\n"] {
        if let Some(rest) = response.strip_prefix(label) { response = rest.trim().to_string(); break; }
    }
    (!response.is_empty()).then_some(response)
}

pub(crate) fn submit_and_wait(hwnd: isize, prompt: &str, marker: &str, timeout: Duration) -> Result<String, String> {
    let _com = ComApartment::mta()?;
    let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| format!("Could not start Windows accessibility: {e}"))?;
    let root = unsafe { automation.ElementFromHandle(HWND(hwnd as _)) }
        .map_err(|e| format!("Could not read the attached Gemini window: {e}"))?;
    let all = elements(&automation, &root)?;
    let (composer, value, current) = find_composer(&all)?;
    let requested = format!("{prompt}\n\nFinish your answer with this exact marker on its own final line: {marker}");
    let (submitted, active_marker) = if is_placeholder(&current) {
        let bstr = BSTR::from(requested.as_str());
        unsafe { value.SetValue(&bstr) }.map_err(|e| format!("Could not put the request into Gemini: {e}"))?;
        if !wait_until_value_matches(&value, &requested) { return Err("Gemini did not accept the complete request in its message box; the draft was left untouched.".into()); }
        (requested, marker.to_string())
    } else if let Some(draft_marker) = marker_from_ade_draft(&current, prompt) {
        // A previous attempt may have filled the composer but failed before the app sent it.
        // Resume that exact ADE-owned draft, preserving its marker and avoiding duplicate text.
        (current, draft_marker)
    } else {
        return Err("Gemini has an unsent draft that does not match this request. It was left untouched; send or clear it, then retry.".into());
    };
    let after_fill = elements(&automation, &root)?;
    if let Err(error) = invoke_send_button(&after_fill) {
        return Err(format!("{error} The request remains as a draft in Gemini."));
    }

    // UIA Invoke can succeed even when a Chromium-hosted control ignores the action.
    // Confirm that Gemini accepted the send before waiting up to ten minutes for a reply.
    let submit_deadline = Instant::now() + Duration::from_secs(6);
    let mut submitted_ok = false;
    while Instant::now() < submit_deadline {
        thread::sleep(Duration::from_millis(300));
        let current = unsafe { value.CurrentValue().map(text).unwrap_or_default() };
        if is_placeholder(&current) {
            submitted_ok = true;
            break;
        }
        let document = page_text(&automation, &root).unwrap_or_default();
        if document.matches(&active_marker).count() >= 2 {
            submitted_ok = true;
            break;
        }
    }
    if !submitted_ok {
        let _ = composer;
        return Err("Gemini kept the request in its composer after the send action. The draft was preserved so it can be retried.".into());
    }

    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    let mut stable = 0;
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(1200));
        let document = page_text(&automation, &root)?;
        if document.matches(&active_marker).count() < 2 { continue; }
        let Some(response) = extract_response(&document, &submitted, &active_marker) else { continue; };
        if response == last { stable += 1; } else { last = response; stable = 0; }
        if stable >= 2 { return Ok(last); }
    }
    Err("Gemini did not produce a complete response through its visible app before the wait timed out.".into())
}

#[cfg(test)]
mod tests {
    use super::{is_placeholder, marker_from_ade_draft, same_visible_text};

    const PROMPT: &str = "Mensagem de teste do Claude Code (ADE AGS).";
    const OWN_DRAFT: &str = "Mensagem de teste do Claude Code (ADE AGS).\n\nFinish your answer with this exact marker on its own final line: ADE_GEMINI_DONE_66ca5e7d162744aa9e4e647e99f64008";

    #[test]
    fn recognizes_and_reuses_only_matching_ade_drafts() {
        assert_eq!(marker_from_ade_draft(OWN_DRAFT, PROMPT).as_deref(), Some("ADE_GEMINI_DONE_66ca5e7d162744aa9e4e647e99f64008"));
        let crlf_draft = OWN_DRAFT.replace("\n\n", "\r\n\r\n");
        assert_eq!(marker_from_ade_draft(&crlf_draft, PROMPT).as_deref(), Some("ADE_GEMINI_DONE_66ca5e7d162744aa9e4e647e99f64008"));
        assert!(marker_from_ade_draft(OWN_DRAFT, "different prompt").is_none());
        assert!(marker_from_ade_draft(&OWN_DRAFT.replace("66ca5e7d162744aa9e4e647e99f64008", "not-a-valid-marker"), PROMPT).is_none());
    }

    #[test]
    fn identifies_empty_and_known_placeholder_values() {
        assert!(is_placeholder("  "));
        assert!(is_placeholder("Peça ao Gemini"));
        assert!(is_placeholder("Ask Gemini"));
        assert!(!is_placeholder(OWN_DRAFT));
    }

    #[test]
    fn accepts_platform_newline_normalization_but_not_changed_words() {
        assert!(same_visible_text("one\r\n\r\ntwo", "one\n\ntwo"));
        assert!(same_visible_text("one\ntwo", "one two"));
        assert!(!same_visible_text("one two", "one too"));
    }
}
