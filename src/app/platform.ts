/** O sistema em que o app roda: decide os botões da janela (os semáforos do macOS à esquerda; os do Windows e do Linux à direita). */
export type DesktopOs = "macos" | "windows" | "linux";

/** O sistema pelo user agent do webview (WKWebView no macOS, WebView2 no Windows, WebKitGTK no Linux). Pura. */
export function osFromUserAgent(ua: string): DesktopOs {
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  return "linux";
}

export const DESKTOP_OS: DesktopOs = typeof navigator === "undefined" ? "macos" : osFromUserAgent(navigator.userAgent);
