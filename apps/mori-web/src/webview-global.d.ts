// The small subset of Electron's WebviewTag used by Mori's T3-browser adapter.
// The real webview is provided by Electron when webviewTag is enabled.
interface MoriElectronWebview extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  isLoading(): boolean;
  sendInputEvent(event: { type: "keyDown" | "keyUp"; keyCode: string }): Promise<void>;
}
interface HTMLElementTagNameMap {
  webview: MoriElectronWebview;
}
