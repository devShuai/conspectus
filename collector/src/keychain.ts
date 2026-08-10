import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { configDir } from "./paths.js";

/**
 * OS keychain access for CLI credentials (design §7.4: access/refresh token
 * and the device signing private key live in the system keychain, never in a
 * plaintext config file).
 *
 * No native/npm dependency: each backend wraps the platform's own command
 * (macOS `security`, Windows Credential Manager via PowerShell CredRead/
 * CredWrite P/Invoke, Linux `secret-tool`/libsecret). This keeps the package
 * installable offline (keytar-style native builds were rejected) at the cost
 * of spawning a process per operation.
 *
 * If the platform command is missing or its storage is unreachable (e.g. a
 * headless Linux session without dbus), we degrade to a 0600 file — the
 * pre-keychain behavior — rather than failing closed and breaking collection.
 */

export interface SecretStore {
  readonly name: string;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = "conspectus-collect";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject); // ENOENT when the command does not exist
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

/** macOS Keychain via /usr/bin/security. */
class MacosSecretStore implements SecretStore {
  readonly name = "macos-keychain";

  async get(account: string): Promise<string | null> {
    const result = await run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
    ]);
    if (result.code !== 0) return null; // errSecItemNotFound
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(account: string, secret: string): Promise<void> {
    // -w puts the secret on the command line briefly (visible to same-user
    // `ps`); `security` has no stdin alternative. Accepted tradeoff.
    const result = await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      secret,
    ]);
    if (result.code !== 0) throw new Error(`keychain write failed: ${result.stderr.trim()}`);
  }

  async delete(account: string): Promise<void> {
    await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
  }
}

/**
 * Windows Credential Manager. `cmdkey` can write but never read back, so we
 * P/Invoke CredReadW/CredWriteW/CredDeleteW (advapi32) from Windows
 * PowerShell — no native build step, ships with the OS. The script goes via
 * -EncodedCommand and the secret (base64) via env var, so neither appears
 * as a plaintext command-line argument. Secrets cross the Node↔PowerShell
 * boundary as base64 because the console codepage is not necessarily UTF-8.
 *
 * Generic credentials cap the blob at 2560 bytes; token JSON with two JWTs
 * can exceed that, so secrets are chunked across `<target>#<i>` entries.
 */
class WindowsSecretStore implements SecretStore {
  readonly name = "windows-credential-manager";
  private static CHUNK_BYTES = 2000;

  private target(account: string, suffix = ""): string {
    return `${SERVICE}:${account}${suffix}`;
  }

  private async ps(op: "read" | "write" | "delete", target: string, secretB64?: string): Promise<RunResult> {
    // -EncodedCommand (UTF-16LE base64) instead of stdin: Windows PowerShell
    // 5.1's `-Command -` consumes stdin interactively and silently drops
    // multi-line scripts with here-strings. The script holds no secrets —
    // target and secret travel via env vars.
    const encoded = Buffer.from(psScript(op), "utf16le").toString("base64");
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: {
        CONSPECTUS_CRED_TARGET: target,
        ...(secretB64 === undefined ? {} : { CONSPECTUS_CRED_SECRET_B64: secretB64 }),
      },
    });
  }

  async get(account: string): Promise<string | null> {
    const parts: string[] = [];
    for (let i = 0; ; i++) {
      const result = await this.ps("read", this.target(account, `#${i}`));
      if (result.code !== 0) break;
      parts.push(Buffer.from(result.stdout.trim(), "base64").toString("utf8"));
    }
    return parts.length === 0 ? null : parts.join("");
  }

  async set(account: string, secret: string): Promise<void> {
    const chunks = chunkByUtf8Bytes(secret, WindowsSecretStore.CHUNK_BYTES);
    for (let i = 0; i < chunks.length; i++) {
      const b64 = Buffer.from(chunks[i], "utf8").toString("base64");
      const result = await this.ps("write", this.target(account, `#${i}`), b64);
      if (result.code !== 0) throw new Error(`credential write failed: ${result.stderr.trim()}`);
    }
    // clear a possible stale chunk from a previously longer secret
    await this.ps("delete", this.target(account, `#${chunks.length}`));
  }

  async delete(account: string): Promise<void> {
    for (let i = 0; ; i++) {
      const result = await this.ps("delete", this.target(account, `#${i}`));
      if (result.code !== 0) break;
    }
  }
}

/**
 * Read a credential owned by an installed tool without copying it into the
 * Conspectus store. Used by read-only collectors such as Claude. The value is
 * kept in memory and callers must never include it in diagnostics.
 */
export async function readExternalCredential(service: string): Promise<string | null> {
  if (process.platform === "darwin") {
    const result = await run("security", ["find-generic-password", "-s", service, "-w"]);
    return result.code === 0 ? result.stdout.replace(/\r?\n$/, "") : null;
  }
  if (process.platform === "win32") {
    const encoded = Buffer.from(psScript("read"), "utf16le").toString("base64");
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { env: { CONSPECTUS_CRED_TARGET: service } },
    );
    return result.code === 0
      ? Buffer.from(result.stdout.trim(), "base64").toString("utf8")
      : null;
  }
  if (process.platform === "linux" || process.platform === "freebsd") {
    const result = await run("secret-tool", ["lookup", "service", service]);
    return result.code === 0 ? result.stdout.replace(/\r?\n$/, "") : null;
  }
  return null;
}

/** Split at code-point boundaries so each chunk stays under maxBytes of UTF-8. */
function chunkByUtf8Bytes(secret: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of secret) {
    const len = Buffer.byteLength(ch, "utf8");
    if (currentBytes + len > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += len;
  }
  chunks.push(current);
  return chunks;
}

function psScript(op: "read" | "write" | "delete"): string {
  const header = `
$ErrorActionPreference = 'Stop'
$target = $env:CONSPECTUS_CRED_TARGET
$src = @'
using System;
using System.Runtime.InteropServices;
public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
}
'@
Add-Type -TypeDefinition $src
`;
  if (op === "read") {
    return `${header}
$ptr = [IntPtr]::Zero
if (-not [CredMan]::CredReadW($target, 1, 0, [ref]$ptr)) { exit 44 }
try {
  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredMan+CREDENTIAL])
  $bytes = New-Object byte[] $c.CredentialBlobSize
  [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
} finally { [CredMan]::CredFree($ptr) }
`;
  }
  if (op === "write") {
    return `${header}
$bytes = [Convert]::FromBase64String($env:CONSPECTUS_CRED_SECRET_B64)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($bytes.Length, 1))
try {
  if ($bytes.Length -gt 0) { [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length) }
  $c = New-Object CredMan+CREDENTIAL
  $c.Type = 1
  $c.TargetName = $target
  $c.CredentialBlobSize = $bytes.Length
  $c.CredentialBlob = $ptr
  $c.Persist = 2
  $c.UserName = 'conspectus'
  if (-not [CredMan]::CredWriteW([ref]$c, 0)) { exit 1 }
} finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
`;
  }
  return `${header}
if (-not [CredMan]::CredDeleteW($target, 1, 0)) { exit 44 }
`;
}

/** Linux/BSD Secret Service via libsecret's `secret-tool` (secret on stdin). */
class LinuxSecretStore implements SecretStore {
  readonly name = "libsecret";

  private attrs(account: string): string[] {
    return ["service", SERVICE, "account", account];
  }

  async get(account: string): Promise<string | null> {
    const result = await run("secret-tool", ["lookup", ...this.attrs(account)]);
    if (result.code !== 0) return null;
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(account: string, secret: string): Promise<void> {
    const result = await run(
      "secret-tool",
      ["store", "--label", `${SERVICE} ${account}`, ...this.attrs(account)],
      { input: secret },
    );
    if (result.code !== 0) throw new Error(`secret-tool store failed: ${result.stderr.trim()}`);
  }

  async delete(account: string): Promise<void> {
    await run("secret-tool", ["clear", ...this.attrs(account)]);
  }
}

/** Last-resort store: 0600 JSON map in the config dir (pre-keychain behavior). */
export class FileSecretStore implements SecretStore {
  readonly name = "file-fallback";

  private file(): string {
    return resolve(configDir(), "secrets.json");
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file())) return {};
    try {
      return JSON.parse(readFileSync(this.file(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeAll(map: Record<string, string>): void {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(this.file(), JSON.stringify(map, null, 2), { mode: 0o600 });
  }

  async get(account: string): Promise<string | null> {
    return this.readAll()[account] ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    const map = this.readAll();
    map[account] = secret;
    this.writeAll(map);
  }

  async delete(account: string): Promise<void> {
    const map = this.readAll();
    if (!(account in map)) return;
    delete map[account];
    if (Object.keys(map).length === 0) {
      if (existsSync(this.file())) unlinkSync(this.file());
      return;
    }
    this.writeAll(map);
  }
}

/** Probe that the OS backend actually works before trusting it. */
async function probe(store: SecretStore): Promise<boolean> {
  const account = `__probe__-${Date.now()}`;
  try {
    if (store instanceof LinuxSecretStore) {
      // A bare lookup succeeds even without a working dbus session on some
      // distros; only a store→lookup→clear roundtrip proves usability.
      await store.set(account, "probe");
      const value = await store.get(account);
      await store.delete(account);
      return value === "probe";
    }
    await store.get(account); // missing item → null, command missing → throw
    return true;
  } catch {
    return false;
  }
}

let injected: SecretStore | null = null;
let detected: SecretStore | null = null;

/** Test hook: force a store (e.g. in-memory fake) or reset detection. */
export function setSecretStoreForTests(store: SecretStore | null): void {
  injected = store;
  detected = null;
}

export async function secretStore(): Promise<SecretStore> {
  if (injected) return injected;
  if (detected) return detected;
  const platformStore =
    process.platform === "darwin"
      ? new MacosSecretStore()
      : process.platform === "win32"
        ? new WindowsSecretStore()
        : process.platform === "linux" || process.platform === "freebsd"
          ? new LinuxSecretStore()
          : null;
  detected = platformStore && (await probe(platformStore)) ? platformStore : new FileSecretStore();
  return detected;
}

/** Which backend is in use (OS keychain vs file fallback); for --diagnose. */
export async function describeSecretStore(): Promise<{ name: string; available: boolean }> {
  const store = await secretStore();
  return { name: store.name, available: !(store instanceof FileSecretStore) };
}
