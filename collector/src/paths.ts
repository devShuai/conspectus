import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Single place for the CLI's on-disk state directory. Read at call time (not
 * module load) so tests can redirect it via CONSPECTUS_CONFIG_DIR.
 */
export function configDir(): string {
  return process.env.CONSPECTUS_CONFIG_DIR ?? resolve(homedir(), ".conspectus");
}
