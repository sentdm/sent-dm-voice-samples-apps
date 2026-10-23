"use client";

import { useAudioDevices } from "@sentdm/voice-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { usePhoneLog } from "./phone-log";
import { reportSdkError } from "./sdk-errors";

export function DevicesCard() {
  const { inputs, outputs, setInput, setOutput } = useAudioDevices();
  const log = usePhoneLog();

  const change = async (kind: "microphone" | "speaker", deviceId: string) => {
    try {
      if (kind === "microphone") await setInput(deviceId);
      else await setOutput(deviceId);
      log.push({ kind: "sdk", title: `${kind} set`, detail: { deviceId } });
    } catch (error) {
      // CAPABILITY_UNSUPPORTED where the browser cannot choose the speaker, for example Firefox and Safari.
      reportSdkError(log, `${kind} not set`, error);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Audio devices</CardTitle>
        <CardDescription>
          Labels appear once the microphone has been allowed in this page. A
          change applies to the call in progress and to later calls.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="microphone">Microphone</Label>
          <NativeSelect
            className="w-full"
            id="microphone"
            defaultValue=""
            onChange={(event) => void change("microphone", event.target.value)}
          >
            <NativeSelectOption value="">Default</NativeSelectOption>
            {inputs.map((device) => (
              <NativeSelectOption
                key={device.deviceId || device.label}
                value={device.deviceId}
              >
                {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="speaker">Speaker</Label>
          <NativeSelect
            className="w-full"
            id="speaker"
            defaultValue=""
            onChange={(event) => void change("speaker", event.target.value)}
          >
            <NativeSelectOption value="">Default</NativeSelectOption>
            {outputs.map((device) => (
              <NativeSelectOption
                key={device.deviceId || device.label}
                value={device.deviceId}
              >
                {device.label || `Speaker ${device.deviceId.slice(0, 6)}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <p className="text-muted-foreground text-xs">
          {inputs.length} microphone{inputs.length === 1 ? "" : "s"},{" "}
          {outputs.length} speaker
          {outputs.length === 1 ? "" : "s"} listed. The list refreshes on
          deviceChanged.
        </p>
      </CardContent>
    </Card>
  );
}
