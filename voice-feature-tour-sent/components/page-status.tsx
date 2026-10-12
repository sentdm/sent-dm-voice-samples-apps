import Link from "next/link";
import type { PropsWithChildren } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

export function Loading({ children }: PropsWithChildren) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <Spinner /> {children}
    </div>
  );
}

/** Shown in place of a screen until the setup screen is saved. `children` ends the sentence. */
export function NotSetUp({ children }: PropsWithChildren) {
  return (
    <Alert>
      <AlertTitle>The app is not set up yet</AlertTitle>
      <AlertDescription>
        <Link href="/setup" className="underline">
          Open the setup screen
        </Link>{" "}
        {children}
      </AlertDescription>
    </Alert>
  );
}
