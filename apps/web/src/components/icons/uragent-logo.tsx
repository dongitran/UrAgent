import { cn } from "@/lib/utils";

export function UrAgentLogo({
  className,
  width = 130,
  height = 20,
  style,
}: {
  width?: number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn("flex items-center font-bold", className)}
      style={{ width, height, ...style }}
    >
      <span className="text-foreground text-lg">UrAgent</span>
    </div>
  );
}
