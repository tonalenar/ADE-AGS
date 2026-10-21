//! As janelas do Chrome real no Windows: nada dele aparece fora do app.
//!
//! - O Chrome controlado (o que manda a tela para o Portal) fica fora da tela e sai da barra de tarefas e
//!   do Alt+Tab (`WS_EX_TOOLWINDOW`). Mudar o estilo estendido de uma janela de outro processo é permitido
//!   e não cria vínculo nenhum entre os dois.
//! - A janela de login (um Chrome comum) vira uma janela *com dono*: o app é o dono, como um diálogo de
//!   outro processo. É a relação entre processos que o Windows suporta ("cross-process owner/owned is
//!   legal", Raymond Chen); a de pai/filho (`SetParent`) é a que dá problema. Com dono, ela fica sempre
//!   acima do app, minimiza junto e não tem botão próprio na barra de tarefas. O app só a posiciona em
//!   cima do Portal: quem desenha e recebe o teclado é o próprio Chrome, a senha não passa pelo app.
//!
//! As janelas novas do Chrome chegam por `SetWinEventHook` (sem varrer em laço), numa thread com fila de
//! mensagens própria que termina quando o processo termina.

use std::cell::RefCell;

use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumWindows, GetAncestor, GetClassNameW, GetWindowLongPtrW, GetWindowThreadProcessId,
    IsWindowVisible, MsgWaitForMultipleObjects, PeekMessageW, PostMessageW, SetForegroundWindow, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, TranslateMessage, EVENT_OBJECT_SHOW, GA_ROOT, GWLP_HWNDPARENT, GWL_EXSTYLE, GWL_STYLE,
    MSG, PM_REMOVE, QS_ALLINPUT, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
    WINEVENT_OUTOFCONTEXT, WM_CLOSE, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

/// Um retângulo de tela em pixels físicos.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Janela do Chrome (`Chrome_WidgetWin_1`), de nível superior e visível, do processo `pid`.
fn chrome_window(hwnd: HWND, pid: u32) -> bool {
    let mut owner_pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut owner_pid) };
    if owner_pid != pid || unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd {
        return false;
    }
    let mut class = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    String::from_utf16_lossy(&class[..n.max(0) as usize]).starts_with("Chrome_WidgetWin")
}

/// Uma janela de navegador (com barra de título), e não um menu ou uma dica.
fn is_frame(hwnd: HWND) -> bool {
    (unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32 & WS_CAPTION) == WS_CAPTION
}

/// Tira a janela da barra de tarefas e do Alt+Tab. O Windows só relê o estilo ao mostrar a janela de novo.
pub fn hide_from_taskbar(hwnd: isize) {
    let hwnd = hwnd as HWND;
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    let wanted = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
    if ex == wanted {
        return;
    }
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
        ShowWindow(hwnd, SW_HIDE);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

/// Dá à janela `hwnd` (de outro processo) o dono `owner`, e a deixa escondida até ganhar um lugar.
pub fn adopt_as_owned(hwnd: isize, owner: isize) {
    let hwnd = hwnd as HWND;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & !WS_EX_APPWINDOW) as isize);
        // Para uma janela de nível superior, GWLP_HWNDPARENT é o DONO (não vira filha).
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner);
        ShowWindow(hwnd, SW_HIDE);
    }
}

/// Põe a janela no retângulo, ou a esconde (`None`: o Portal não está à vista).
pub fn place(hwnd: isize, rect: Option<Rect>) {
    let hwnd = hwnd as HWND;
    unsafe {
        match rect {
            Some(r) => {
                SetWindowPos(hwnd, std::ptr::null_mut(), r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
            None => {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

pub fn focus(hwnd: isize) {
    unsafe { SetForegroundWindow(hwnd as HWND) };
}

/// Pede para a janela fechar, como o X dela: o Chrome encerra normalmente e grava a sessão.
pub fn close(hwnd: isize) {
    unsafe { PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0) };
}

thread_local! {
    static ON_WINDOW: RefCell<Option<(u32, Box<dyn FnMut(isize, bool)>)>> = const { RefCell::new(None) };
}

unsafe extern "system" fn on_show(_: HWINEVENTHOOK, _: u32, hwnd: HWND, id_object: i32, id_child: i32, _: u32, _: u32) {
    // OBJID_WINDOW = 0, CHILDID_SELF = 0: a própria janela, não um elemento dentro dela.
    if id_object != 0 || id_child != 0 || hwnd.is_null() {
        return;
    }
    ON_WINDOW.with(|slot| {
        if let Some((pid, f)) = slot.borrow_mut().as_mut() {
            if chrome_window(hwnd, *pid) {
                f(hwnd as isize, is_frame(hwnd));
            }
        }
    });
}

unsafe extern "system" fn each_window(hwnd: HWND, _: LPARAM) -> i32 {
    unsafe { on_show(std::ptr::null_mut(), EVENT_OBJECT_SHOW, hwnd, 0, 0, 0, 0) };
    1
}

/// Chama `f(janela, é_um_quadro)` para cada janela do Chrome `pid` que aparecer (e as que já existem),
/// até o processo terminar. Roda numa thread própria.
pub fn watch_windows(pid: u32, f: impl FnMut(isize, bool) + Send + 'static) {
    std::thread::spawn(move || {
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return;
        }
        ON_WINDOW.with(|slot| *slot.borrow_mut() = Some((pid, Box::new(f))));
        let hook = unsafe {
            SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, std::ptr::null_mut(), Some(on_show), pid, 0, WINEVENT_OUTOFCONTEXT)
        };
        unsafe { EnumWindows(Some(each_window), 0) };
        loop {
            let woke = unsafe { MsgWaitForMultipleObjects(1, &process, 0, u32::MAX, QS_ALLINPUT) };
            if woke == WAIT_OBJECT_0 {
                break;
            }
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            while unsafe { PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
                unsafe {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        unsafe {
            if !hook.is_null() {
                UnhookWinEvent(hook);
            }
            CloseHandle(process);
        }
        ON_WINDOW.with(|slot| *slot.borrow_mut() = None);
    });
}
