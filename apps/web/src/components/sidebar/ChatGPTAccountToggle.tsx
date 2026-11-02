import { UserRoundIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  PRIMARY_CHATGPT_PROFILE_ID,
  SECONDARY_CHATGPT_PROFILE_ID,
  chatGPTNewSessionProfileKey,
  chatGPTSessionProfileId,
} from "../../chatGPTAccountProfiles";

export function ChatGPTAccountToggle({ environmentId }: { readonly environmentId: string }) {
  const [selected, setSelected] = useLocalStorage(
    chatGPTNewSessionProfileKey(environmentId),
    PRIMARY_CHATGPT_PROFILE_ID as string,
    Schema.String,
  );
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Account for new ChatGPT sessions">
      {([
        [PRIMARY_CHATGPT_PROFILE_ID, "First", "text-sky-300 bg-sky-400/15 border-sky-400/50"],
        [SECONDARY_CHATGPT_PROFILE_ID, "Second", "text-amber-300 bg-amber-400/15 border-amber-400/50"],
      ] as const).map(([id, name, color]) => (
        <button
          key={id}
          type="button"
          aria-label={`Use ${name.toLowerCase()} ChatGPT account for new sessions`}
          title={`New ChatGPT sessions: ${name.toLowerCase()} account`}
          aria-pressed={selected === id}
          onClick={() => setSelected(id)}
          className={`flex size-[21px] shrink-0 items-center justify-center rounded border transition-colors ${color} ${selected === id ? "ring-1 ring-ring ring-offset-1 ring-offset-background" : "opacity-55 border-transparent hover:opacity-100"}`}
        >
          <UserRoundIcon aria-hidden="true" className="size-3" />
        </button>
      ))}
    </div>
  );
}

export function ChatGPTAccountBadge({
  session,
}: {
  readonly session: { readonly profileId?: string | undefined };
}) {
  const second = chatGPTSessionProfileId(session) === SECONDARY_CHATGPT_PROFILE_ID;
  if (!second) return null;
  return (
    <span
      className="flex size-3 shrink-0 items-center justify-center rounded-full bg-amber-400/25 text-amber-300"
      title="Second ChatGPT account (fixed)"
      aria-label="Second ChatGPT account"
    >
      <UserRoundIcon aria-hidden="true" className="size-2.5" />
    </span>
  );
}
