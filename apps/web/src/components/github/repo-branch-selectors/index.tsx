import { BranchSelector } from "./branch-selector";
import { useQueryState } from "nuqs";

export function RepositoryBranchSelectors() {
  const [threadId] = useQueryState("threadId");
  const chatStarted = !!threadId;
  const defaultButtonStyles =
    "bg-inherit border-none text-foreground hover:text-foreground/80 text-xs p-0 px-0 py-0 !p-0 !px-0 !py-0 h-fit hover:bg-inherit shadow-none";
  const defaultStylesChatStarted =
    "hover:bg-inherit cursor-default hover:cursor-default text-foreground hover:border-gray-300 hover:ring-inherit shadow-none p-0 px-0 py-0 !p-0 !px-0 !py-0";

  // Only show branch selector - repository is fixed from env config
  return (
    <div className="flex items-center gap-1 rounded-md border border-gray-200 p-1 dark:border-gray-700">
      <div className="flex items-center gap-0">
        <BranchSelector
          chatStarted={chatStarted}
          buttonClassName={
            defaultButtonStyles +
            (chatStarted ? " " + defaultStylesChatStarted : "")
          }
        />
      </div>
    </div>
  );
}
