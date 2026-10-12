import { setTimeout as sleep } from "node:timers/promises";
import type {
  AppConfig,
  ParticipantTarget,
  TransferResult,
} from "@/lib/shared/types";
import {
  addParticipant,
  listParticipants,
  removeParticipant,
} from "./sent-api";

/**
 * Transfer, built from the participant commands the API offers: dial the new party into
 * the room, wait until the roster lists them (a ringing leg is not listed yet), then remove
 * the agent's own leg. Caller and new party stay connected.
 */

const POLL_INTERVAL_MS = 1000;
const MAX_WAIT_MS = 45_000;

export async function transferCall(
  config: AppConfig,
  roomCallId: string,
  agentLegId: string,
  target: ParticipantTarget,
  callerId?: string
): Promise<TransferResult> {
  const steps: string[] = [];

  const participant = await addParticipant(
    config,
    roomCallId,
    target,
    callerId
  );
  steps.push(`Dialed ${target.value} into the room as ${participant.id}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  let connected = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const roster = await listParticipants(config, roomCallId);
    if (roster.some((entry) => entry.id === participant.id)) {
      connected = true;
      break;
    }
  }

  if (!connected) {
    steps.push(
      `${target.value} did not join within ${MAX_WAIT_MS / 1000} seconds; the agent stays in the call`
    );
    throw new TransferError(steps);
  }
  steps.push(`${target.value} joined the room`);

  await removeParticipant(config, roomCallId, agentLegId);
  steps.push(`Removed the agent's leg ${agentLegId}`);

  return { participantId: participant.id, steps };
}

export class TransferError extends Error {
  constructor(readonly steps: string[]) {
    super(steps[steps.length - 1] ?? "Transfer failed");
    this.name = "TransferError";
  }
}
