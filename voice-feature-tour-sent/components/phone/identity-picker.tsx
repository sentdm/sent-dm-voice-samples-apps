"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IDENTITY_PATTERN } from "@/lib/shared/validation";

const suggestions = ["agent-1", "agent-2", "support"];

export function IdentityPicker({
  onPick,
}: {
  onPick: (identity: string) => void;
}) {
  const [value, setValue] = useState("");
  const valid = IDENTITY_PATTERN.test(value);

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Who is this browser?</CardTitle>
        <CardDescription>
          The identity your backend mints tokens for. Other app users reach you
          by this name. Letters, digits, - and _ only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onPick(value);
          }}
        >
          <Label htmlFor="identity">Identity</Label>
          <Input
            id="identity"
            autoFocus
            value={value}
            placeholder="agent-1"
            onChange={(event) => setValue(event.target.value.trim())}
            aria-invalid={value.length > 0 && !valid}
          />
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onPick(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          <Button type="submit" disabled={!valid}>
            Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
