import { ipcRenderer } from "electron";

import { CHATGPT_PAGE_PUSH_CHANNEL, PASSKEY_BRIDGE_ARGUMENT } from "./preview/GuestProtocol.ts";
import { installChatGPTPagePushObserver } from "./preview/ChatGPTPagePushPreload.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import "./preview/PickPreload.ts";

installChatGPTPagePushObserver(document, location, () => {
  ipcRenderer.sendToHost(CHATGPT_PAGE_PUSH_CHANNEL);
});

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}
