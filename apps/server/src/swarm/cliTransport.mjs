// Thin CLI adapter only. The shared Swarm domain never imports unbundled scripts.
// These are T3's existing named-pipe controllers, not new senders or retry queues.
import { controlNativeThreads } from "../../../../scripts/t3-native-threads.mjs";
import { controlSessions } from "../../../../scripts/chatgpt-sessions.mjs";

export const swarmCliTransports = {
  native: controlNativeThreads,
  chatgpt: controlSessions,
};
