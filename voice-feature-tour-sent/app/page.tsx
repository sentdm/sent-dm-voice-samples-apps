import { redirect } from "next/navigation";
import { readConfig } from "@/lib/server/config-store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const config = await readConfig();
  redirect(config ? "/phone" : "/setup");
}
