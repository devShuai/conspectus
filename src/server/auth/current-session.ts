import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "./cookies";
import { dbSessionWriter } from "./db-flow";

export interface CurrentSession {
  userId: string;
  /** Session row id; sensitive actions bind their reauth to it (#99). */
  sessionId: string;
}

export async function currentAppSession(): Promise<CurrentSession | null> {
  const cookieStore = await cookies();
  return dbSessionWriter.find(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}
