import { useMemo } from "react";
import { cn } from "cn";
import { pretty } from "@/lib/client/format";

export function JsonView({
  value,
  className,
  maxHeight = "24rem",
}: {
  value: unknown;
  className?: string;
  maxHeight?: string;
}) {
  const text = useMemo(() => pretty(value), [value]);
  return (
    <pre
      className={cn(
        "bg-muted/60 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed",
        className
      )}
      style={{ maxHeight }}
    >
      {text}
    </pre>
  );
}
