"use client";

import { Loading, NotSetUp } from "@/components/page-status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppState } from "@/lib/client/use-app-events";
import { usePublicConfig } from "@/lib/client/use-public-config";
import { ApiExplorer } from "./api-explorer";
import { CallLog } from "./call-log";
import { CallbackStudio } from "./callback-studio";
import { PresenceStrip } from "./presence-strip";
import { TelemetryFeed } from "./telemetry-feed";
import { WebhooksInbox } from "./webhooks-inbox";

export function ConsoleView() {
  const { state, connected, configVersion } = useAppState();
  const [config, setConfig] = usePublicConfig(configVersion);

  if (config === undefined) return <Loading>Loading</Loading>;
  if (!config?.configured) return <NotSetUp>first.</NotSetUp>;

  return (
    <div className="flex flex-col gap-4">
      <PresenceStrip
        presence={state?.presence ?? []}
        calls={state?.calls ?? []}
        connected={connected}
      />
      <Tabs defaultValue="explorer">
        <TabsList>
          <TabsTrigger value="explorer">API explorer</TabsTrigger>
          <TabsTrigger value="callback">Callback studio</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="telemetry">Telemetry</TabsTrigger>
          <TabsTrigger value="calls">Call log</TabsTrigger>
        </TabsList>
        <TabsContent value="explorer">
          <ApiExplorer config={config} />
        </TabsContent>
        <TabsContent value="callback">
          <CallbackStudio
            config={config}
            entries={state?.callbackLog ?? []}
            rules={state?.routing ?? null}
          />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksInbox
            config={config}
            entries={state?.webhookInbox ?? []}
            onConfigChange={setConfig}
          />
        </TabsContent>
        <TabsContent value="telemetry">
          <TelemetryFeed entries={state?.telemetry ?? []} />
        </TabsContent>
        <TabsContent value="calls">
          <CallLog config={config} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
