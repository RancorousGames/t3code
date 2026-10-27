import { create } from "zustand";

// Targeted activation: a message needing an old unloaded conversation
// activates only that guest, rather than the startup mass-load policy.
export const useChatGPTDeliveryMountRequests = create<{
  required: Readonly<Record<string, true>>;
}>(() => ({ required: {} }));

const mountUsers = new Map<string, number>();

export function requestChatGPTDeliveryMount(environmentId: string, sessionId: string): void {
  const key = environmentId + ":" + sessionId;
  mountUsers.set(key, (mountUsers.get(key) ?? 0) + 1);
  const required = useChatGPTDeliveryMountRequests.getState().required;
  if (required[key]) return;
  useChatGPTDeliveryMountRequests.setState({ required: { ...required, [key]: true } });
}

/** Release a targeted guest after its delivery attempt completes. */
export function releaseChatGPTDeliveryMount(environmentId: string, sessionId: string): void {
  const key = environmentId + ":" + sessionId;
  const users = mountUsers.get(key) ?? 0;
  if (users > 1) {
    mountUsers.set(key, users - 1);
    return;
  }
  mountUsers.delete(key);
  const { [key]: _released, ...required } = useChatGPTDeliveryMountRequests.getState().required;
  if (_released) useChatGPTDeliveryMountRequests.setState({ required });
}
