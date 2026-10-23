import { LoaderCircleIcon } from "lucide-react";

import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import { ChatGPTBrowserSessionActivityIcon } from "./ChatGPTBrowserSessionActivity";
import { chatGPTActivityColorClass, type ChatGPTActivityAge } from "./chatGPTActivity";

/** Project identity is stable across live heartbeats, guest failures and session renames. */
export function ChatGPTProjectStatusIcon({
  project,
  age,
  recovering,
}: {
  readonly project: string | undefined;
  readonly age: ChatGPTActivityAge;
  readonly recovering: boolean;
}) {
  if (!project) return <ChatGPTBrowserSessionActivityIcon age={age} recovering={recovering} />;
  const { monogram, color } = deriveProjectIdentity(project);
  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <ProjectMonogram text={monogram} color={color} className="size-4.5" />
      <span
        className={`absolute -right-0.5 -bottom-0.5 flex size-2.5 items-center justify-center rounded-full bg-sidebar ${chatGPTActivityColorClass(age)}`}
        aria-hidden
      >
        {recovering ? (
          <LoaderCircleIcon className="size-2.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <span className="size-2 rounded-full bg-current" />
        )}
      </span>
    </span>
  );
}
