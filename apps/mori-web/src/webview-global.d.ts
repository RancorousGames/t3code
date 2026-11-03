// The small subset of Electron's WebviewTag used by Mori's T3-browser adapter.
// The real webview is provided by Electron when webviewTag is enabled.
interface MoriElectronWebview extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  isLoading(): boolean;
  sendInputEvent(event: { type: "keyDown" | "keyUp"; keyCode: string }): Promise<void>;
}
// T3 shared browser automation has an optional native bridge branch. Mori's
// sessions use WebviewTag, but the optional field keeps shared types complete.
interface Window {
  desktopBridge?: { stableChatGPTViewRequest?: (request: {
    operation: string;
    identity: { sessionId: string; environmentId: string; profileId: string };
    expression?: string;
  }) => Promise<{ result?: unknown }> };
}
interface HTMLElementTagNameMap {
  webview: MoriElectronWebview;
}
