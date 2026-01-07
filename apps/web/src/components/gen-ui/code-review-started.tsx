"use client";

import { FileSearch, CheckCircle, Loader2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { cn } from "@/lib/utils";

type CodeReviewStartedProps = {
  status?: "generating" | "done";
};

export function CodeReviewStarted({ status = "done" }: CodeReviewStartedProps) {
  const isGenerating = status === "generating";

  return (
    <div
      className={cn(
        "dark:border-muted-foreground/20 dark:bg-muted/30 rounded-lg border shadow-sm transition-shadow",
        "shadow-sm hover:shadow-md",
        isGenerating
          ? "border-blue-200/60 bg-blue-50/30"
          : "border-green-200/60 bg-green-50/30",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "dark:bg-muted/40 relative flex items-center p-3",
          "rounded-lg",
          isGenerating ? "bg-blue-50/50" : "bg-green-50/50",
        )}
      >
        <div className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full",
          isGenerating
            ? "bg-blue-500/90 dark:bg-blue-600"
            : "bg-green-500/90 dark:bg-green-600"
        )}>
          <FileSearch className="h-3.5 w-3.5 text-white" />
        </div>

        <div className="ml-3 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-foreground text-sm font-medium">Code review</h3>
            <Badge
              variant="secondary"
              className={cn(
                isGenerating
                  ? "border-blue-200/60 bg-blue-100/80 text-blue-700 dark:border-blue-700/40 dark:bg-blue-900/50 dark:text-blue-300"
                  : "border-green-200/60 bg-green-100/80 text-green-700 dark:border-green-700/40 dark:bg-green-900/50 dark:text-green-300"
              )}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  In progress
                </>
              ) : (
                <>
                  <CheckCircle className="h-3 w-3" />
                  Completed
                </>
              )}
            </Badge>
          </div>
          <p className="text-muted-foreground/80 mt-1 text-xs">
            {isGenerating ? "Analyzing code quality" : "Code review completed"}
          </p>
        </div>
      </div>
    </div>
  );
}
