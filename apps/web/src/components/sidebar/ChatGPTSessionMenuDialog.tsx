import { useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export type ChatGPTSessionMenuDialogState =
  | { kind: "rename-group"; groupKey: string; title: string }
  | { kind: "add-project"; sessionId: string }
  | {
      kind: "binding";
      sessionId: string;
      role: "manager" | "worker" | "personal";
      seat: string;
      task: string;
    }
  | { kind: "reboot"; sessionId: string; prompt: string };

export function ChatGPTSessionMenuDialog({
  dialog,
  close,
  submit,
}: {
  dialog: ChatGPTSessionMenuDialogState;
  close: () => void;
  submit: (values: {
    title: string;
    role: "manager" | "worker" | "personal";
    seat: string;
    task: string;
    prompt: string;
  }) => void;
}) {
  const [title, setTitle] = useState(dialog.kind === "rename-group" ? dialog.title : "");
  const [role, setRole] = useState<"manager" | "worker" | "personal">(
    dialog.kind === "binding" ? dialog.role : "personal",
  );
  const [seat, setSeat] = useState(dialog.kind === "binding" ? dialog.seat : "");
  const [task, setTask] = useState(dialog.kind === "binding" ? dialog.task : "");
  const [prompt, setPrompt] = useState(dialog.kind === "reboot" ? dialog.prompt : "");
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit({
      title: title.trim(),
      role,
      seat: seat.trim(),
      task: task.trim(),
      prompt: prompt.trim(),
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {dialog.kind === "rename-group"
              ? "Rename project group"
              : dialog.kind === "add-project"
                ? "Add project"
                : dialog.kind === "reboot"
                  ? "Reboot agent"
                  : "Edit Omniwork binding"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <div className="space-y-3 px-6 pb-4">
            {(dialog.kind === "rename-group" || dialog.kind === "add-project") && (
              <Input
                autoFocus
                aria-label="Project group name"
                placeholder="Project name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            )}
            {dialog.kind === "add-project" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Create a ChatGPT sidebar project and move this session into it.
                </p>
                {title.trim().toLowerCase() === "other" && (
                  <p role="alert" className="text-sm text-destructive">
                    Other is reserved for ungrouped sessions.
                  </p>
                )}
              </>
            )}
            {dialog.kind === "binding" && (
              <>
                <label className="block text-sm">
                  Role
                  <select
                    className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2"
                    value={role}
                    onChange={(event) => setRole(event.target.value as typeof role)}
                  >
                    <option value="personal">Personal</option>
                    <option value="worker">Worker</option>
                    <option value="manager">Manager</option>
                  </select>
                </label>
                <label className="block text-sm">
                  OpenRig seat ID (optional)
                  <Input value={seat} onChange={(event) => setSeat(event.target.value)} />
                </label>
                <label className="block text-sm">
                  TaskBoard reference (Board:ID, optional)
                  <Input
                    value={task}
                    onChange={(event) => setTask(event.target.value)}
                    placeholder="t3code:T3-0191"
                  />
                </label>
              </>
            )}
            {dialog.kind === "reboot" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Starts a new ChatGPT conversation in the same T3 session. Enter the continuation
                  instructions for the new agent.
                </p>
                <textarea
                  autoFocus
                  aria-label="Reboot handoff"
                  rows={5}
                  required
                  className="w-full rounded-md border border-input bg-background p-2 text-sm"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                dialog.kind === "rename-group" || dialog.kind === "add-project"
                  ? !title.trim() ||
                    (dialog.kind === "add-project" && title.trim().toLowerCase() === "other")
                  : dialog.kind === "reboot"
                    ? !prompt.trim()
                    : false
              }
            >
              {dialog.kind === "reboot"
                ? "Reboot agent"
                : dialog.kind === "add-project"
                  ? "Create and move"
                  : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
