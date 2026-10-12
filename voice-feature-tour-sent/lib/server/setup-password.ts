import { timingSafeEqual } from "node:crypto";

/**
 * Optional gate for the screens that change configuration: setup, routing rules and the
 * webhook subscription. Off unless `SETUP_PASSWORD` is set. The browser sends the password in
 * the `x-setup-password` header after the user typed it on the setup screen.
 */
export function isSetupPasswordRequired(): boolean {
  return Boolean(process.env.SETUP_PASSWORD);
}

export class SetupPasswordError extends Error {
  constructor() {
    super("The setup password is required");
    this.name = "SetupPasswordError";
  }
}

export function assertSetupPassword(request: Request): void {
  const expected = process.env.SETUP_PASSWORD;
  if (!expected) return;
  const provided = Buffer.from(request.headers.get("x-setup-password") ?? "");
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted))
    throw new SetupPasswordError();
}
