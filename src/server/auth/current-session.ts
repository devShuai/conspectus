import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "./cookies";
import { findAppSession, type AppSession } from "./session";

export async function currentAppSession(): Promise<AppSession | null> {
  const cookieStore = await cookies();
  return findAppSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}
