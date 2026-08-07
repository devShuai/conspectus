import { validAccessToken } from "./auth.js";
/**
 * Report readings to conspectus /api/collect/usage. Buffered on failure;
 * caller retries the batch later (no data loss on transient errors).
 */
export async function reportReadings(config, readings, deviceId, signature, timestamp) {
    const tokens = await validAccessToken(config);
    const response = await fetch(`${config.serverUrl}/api/collect/usage`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${tokens.accessToken}`,
            "content-type": "application/json",
            ...(signature
                ? {
                    "x-device-id": deviceId ?? "",
                    "x-device-signature": signature,
                    "x-device-timestamp": timestamp ?? new Date().toISOString(),
                }
                : {}),
        },
        body: JSON.stringify({ deviceId, readings }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`report failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return (await response.json());
}
/** Fetch the manifest of bindings this collector may write. */
export async function fetchManifest(config) {
    const tokens = await validAccessToken(config);
    const response = await fetch(`${config.serverUrl}/api/collect/manifest`, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!response.ok)
        throw new Error(`manifest failed: ${response.status}`);
    const body = (await response.json());
    return body.bindings.map((b) => b.bindingId);
}
