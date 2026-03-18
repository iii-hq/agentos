import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { requireAuth } from "./shared/utils.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "security-map",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const NONCE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 60 * 1000;

registerFunction(
  {
    id: "security::map_challenge",
    description: "Generate MAP mutual-auth challenge nonce",
    metadata: { category: "security" },
  },
  async ({
    sourceAgent,
    targetAgent,
  }: {
    sourceAgent: string;
    targetAgent: string;
  }) => {
    if (!sourceAgent || !targetAgent) {
      throw new Error("sourceAgent and targetAgent are required");
    }

    const nonce = randomBytes(32).toString("hex");
    const timestamp = Date.now();

    await trigger({
      function_id: "state::set",
      payload: {
        scope: "map_challenges",
        key: nonce,
        value: { nonce, timestamp, sourceAgent, targetAgent },
      },
    });

    triggerVoid("security::audit", {
      type: "map_challenge_issued",
      detail: { sourceAgent, targetAgent, nonce: nonce.slice(0, 8) },
    });

    return { nonce, timestamp, sourceAgent };
  },
);

registerFunction(
  {
    id: "security::map_respond",
    description: "Sign MAP challenge nonce with shared secret",
    metadata: { category: "security" },
  },
  async ({
    nonce,
    sourceAgent,
    responderAgent,
    timestamp,
  }: {
    nonce: string;
    sourceAgent: string;
    responderAgent: string;
    timestamp: number;
  }) => {
    if (!nonce || !sourceAgent || !responderAgent) {
      throw new Error("nonce, sourceAgent, and responderAgent are required");
    }

    const secretEntry: any = await trigger({
      function_id: "vault::get",
      payload: { key: `map:${responderAgent}` },
    }).catch(() => null);

    if (!secretEntry?.value) {
      throw new Error("No shared secret configured for agent");
    }

    const payload = `${nonce}:${sourceAgent}:${responderAgent}:${timestamp}`;
    const signature = createHmac("sha256", secretEntry.value)
      .update(payload)
      .digest("hex");

    return { signature, nonce, responderAgent };
  },
);

registerFunction(
  {
    id: "security::map_verify",
    description: "Verify MAP mutual-auth response signature",
    metadata: { category: "security" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { nonce, signature, responderAgent } = req.body || req;

    if (!nonce || !signature || !responderAgent) {
      throw new Error("nonce, signature, and responderAgent are required");
    }

    const challenge: any = await trigger({
      function_id: "state::get",
      payload: { scope: "map_challenges", key: nonce },
    }).catch(() => null);

    if (!challenge) {
      await trigger({
        function_id: "state::delete",
        payload: { scope: "map_challenges", key: nonce },
      }).catch(() => {});
      triggerVoid("security::audit", {
        type: "map_verify_failed",
        detail: { reason: "unknown_nonce", responderAgent },
      });
      return { verified: false, reason: "unknown_nonce" };
    }

    if (Date.now() - challenge.timestamp > CHALLENGE_WINDOW_MS) {
      await trigger({
        function_id: "state::delete",
        payload: { scope: "map_challenges", key: nonce },
      });
      triggerVoid("security::audit", {
        type: "map_verify_failed",
        detail: { reason: "expired", responderAgent },
      });
      return { verified: false, reason: "challenge_expired" };
    }

    const usedNonce: any = await trigger({
      function_id: "state::get",
      payload: { scope: "map_used_nonces", key: nonce },
    }).catch(() => null);

    if (usedNonce) {
      await trigger({
        function_id: "state::delete",
        payload: { scope: "map_challenges", key: nonce },
      }).catch(() => {});
      triggerVoid("security::audit", {
        type: "map_verify_failed",
        detail: { reason: "replay_detected", responderAgent },
      });
      return { verified: false, reason: "replay_detected" };
    }

    const secretEntry: any = await trigger({
      function_id: "vault::get",
      payload: { key: `map:${responderAgent}` },
    }).catch(() => null);

    if (!secretEntry?.value) {
      return { verified: false, reason: "no_shared_secret" };
    }

    const payload = `${nonce}:${challenge.sourceAgent}:${responderAgent}:${challenge.timestamp}`;
    const expected = createHmac("sha256", secretEntry.value)
      .update(payload)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "hex");
    const signatureBuf = Buffer.from(signature, "hex");
    const verified =
      expectedBuf.length === signatureBuf.length &&
      timingSafeEqual(expectedBuf, signatureBuf);

    await trigger({
      function_id: "state::set",
      payload: {
        scope: "map_used_nonces",
        key: nonce,
        value: { usedAt: Date.now(), responderAgent },
      },
    });

    await trigger({
      function_id: "state::delete",
      payload: { scope: "map_challenges", key: nonce },
    });

    setTimeout(async () => {
      await trigger({
        function_id: "state::delete",
        payload: { scope: "map_used_nonces", key: nonce },
      }).catch(() => {});
    }, NONCE_TTL_MS);

    triggerVoid("security::audit", {
      type: verified ? "map_verify_success" : "map_verify_failed",
      detail: { responderAgent, sourceAgent: challenge.sourceAgent },
    });

    return { verified, agent: verified ? responderAgent : undefined };
  },
);

registerTrigger({
  type: "http",
  function_id: "security::map_challenge",
  config: { api_path: "api/security/map/challenge", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "security::map_verify",
  config: { api_path: "api/security/map/verify", http_method: "POST" },
});
