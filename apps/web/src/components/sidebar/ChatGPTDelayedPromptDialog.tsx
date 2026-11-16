// Shared Caffy schedule metadata. The editor for existing and new sessions
// now lives in ChatGPTAutoContinueDialog.tsx.
export type DelayedPromptTarget =
  | { kind: "existing"; sessionId: string; sessionTitle: string; beginAt: number }
  | { kind: "new" }
  | { kind: "scheduled"; job: ScheduledChatGPTJob; prompt: string };

export interface ScheduledChatGPTJob {
  id: string;
  title: string;
  beginAt: number | null;
  onIdle?: boolean;
  status: "scheduled" | "dispatching" | "created" | "uncertain";
  sessionId?: string;
  error?: string;
}
