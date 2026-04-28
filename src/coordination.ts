import { registerWorker, TriggerAction, Logger } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { requireAuth, sanitizeId } from "@agentos/shared/utils";
import { createRecordMetric } from "@agentos/shared/metrics";
import { safeCall } from "@agentos/shared/errors";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "coordination",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const log = new Logger();
const recordMetric = createRecordMetric(triggerVoid);

const MAX_POSTS_PER_CHANNEL = 1000;
const MAX_PINNED = 25;

registerFunction(
  {
    id: "coord::create_channel",
    description: "Create a coordination channel for agent communication",
    metadata: { category: "coordination" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { name, topic, agentId } = req.body || req;
    if (!name || !agentId) {
      throw Object.assign(
        new Error("name and agentId are required"),
        { statusCode: 400 },
      );
    }

    const channelId = crypto.randomUUID();
    const channel = {
      id: channelId,
      name: sanitizeId(name),
      topic: topic || "",
      createdBy: sanitizeId(agentId),
      createdAt: Date.now(),
      pinned: [] as string[],
    };

    await trigger({ function_id: "state::set", payload: {
      scope: "coord_channels",
      key: channelId,
      value: channel,
    } });

    triggerVoid("publish", {
      topic: `coord:${channelId}`,
      data: { type: "channel_created", channelId, name: channel.name },
    });

    log.info("Channel created", { channelId, name: channel.name, agentId });
    recordMetric("coord_channel_created", 1, { agentId }, "counter");

    return { channelId, name: channel.name };
  },
);

registerFunction(
  {
    id: "coord::post",
    description: "Post a message to a coordination channel",
    metadata: { category: "coordination" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { channelId, agentId, content, metadata: extraMeta } =
      req.body || req;

    if (!channelId || !agentId || !content) {
      throw Object.assign(
        new Error("channelId, agentId, and content are required"),
        { statusCode: 400 },
      );
    }

    const safeChannelId = sanitizeId(channelId);
    const channel = await trigger({ function_id: "state::get", payload: {
      scope: "coord_channels",
      key: safeChannelId,
    } });
    if (!channel) {
      throw Object.assign(new Error("Channel not found"), {
        statusCode: 404,
      });
    }

    const existing: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: `coord_posts:${safeChannelId}` } }),
      [],
      { operation: "list_posts" },
    );
    if (existing.length >= MAX_POSTS_PER_CHANNEL) {
      throw Object.assign(
        new Error("Channel has reached the post limit"),
        { statusCode: 400 },
      );
    }

    const postId = crypto.randomUUID();
    const post = {
      id: postId,
      channelId: safeChannelId,
      agentId: sanitizeId(agentId),
      content,
      parentId: undefined as string | undefined,
      createdAt: Date.now(),
      metadata: extraMeta || {},
    };

    await trigger({ function_id: "state::set", payload: {
      scope: `coord_posts:${safeChannelId}`,
      key: postId,
      value: post,
    } });

    triggerVoid("publish", {
      topic: `coord:${safeChannelId}`,
      data: { type: "post_created", postId, agentId: post.agentId },
    });

    recordMetric("coord_post_created", 1, { agentId: post.agentId }, "counter");

    return { postId, channelId: safeChannelId };
  },
);

registerFunction(
  {
    id: "coord::reply",
    description: "Reply to a post in a coordination channel (threaded)",
    metadata: { category: "coordination" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { channelId, parentId, agentId, content, metadata: extraMeta } =
      req.body || req;

    if (!channelId || !parentId || !agentId || !content) {
      throw Object.assign(
        new Error("channelId, parentId, agentId, and content are required"),
        { statusCode: 400 },
      );
    }

    const safeChannelId = sanitizeId(channelId);
    const safeParentId = sanitizeId(parentId);

    const parent = await trigger({ function_id: "state::get", payload: {
      scope: `coord_posts:${safeChannelId}`,
      key: safeParentId,
    } });
    if (!parent) {
      throw Object.assign(new Error("Parent post not found"), {
        statusCode: 404,
      });
    }

    const postId = crypto.randomUUID();
    const reply = {
      id: postId,
      channelId: safeChannelId,
      agentId: sanitizeId(agentId),
      content,
      parentId: safeParentId,
      createdAt: Date.now(),
      metadata: extraMeta || {},
    };

    await trigger({ function_id: "state::set", payload: {
      scope: `coord_posts:${safeChannelId}`,
      key: postId,
      value: reply,
    } });

    triggerVoid("publish", {
      topic: `coord:${safeChannelId}`,
      data: {
        type: "reply_created",
        postId,
        parentId: safeParentId,
        agentId: reply.agentId,
      },
    });

    return { postId, parentId: safeParentId, channelId: safeChannelId };
  },
);

registerFunction(
  {
    id: "coord::list_channels",
    description: "List all coordination channels",
    metadata: { category: "coordination" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "coord_channels" } }),
      [],
      { operation: "list_channels" },
    );

    return (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
  },
);

registerFunction(
  {
    id: "coord::read",
    description: "Read messages in a coordination channel",
    metadata: { category: "coordination" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { channelId, threadId, limit } = req.body || req.query || req;

    if (!channelId) {
      throw Object.assign(new Error("channelId is required"), {
        statusCode: 400,
      });
    }

    const safeChannelId = sanitizeId(channelId);

    const all: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: `coord_posts:${safeChannelId}` } }),
      [],
      { operation: "read_posts" },
    );

    let posts = (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0));

    if (threadId) {
      const safeThreadId = sanitizeId(threadId);
      posts = posts.filter(
        (p: any) => p.id === safeThreadId || p.parentId === safeThreadId,
      );
    }

    const cap = typeof limit === "number" && limit > 0 ? limit : 100;
    return posts.slice(-cap);
  },
);

registerFunction(
  {
    id: "coord::pin",
    description: "Pin or unpin a post in a coordination channel",
    metadata: { category: "coordination" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { channelId, postId, unpin } = req.body || req;

    if (!channelId || !postId) {
      throw Object.assign(
        new Error("channelId and postId are required"),
        { statusCode: 400 },
      );
    }

    const safeChannelId = sanitizeId(channelId);
    const safePostId = sanitizeId(postId);

    const channel: any = await trigger({ function_id: "state::get", payload: {
      scope: "coord_channels",
      key: safeChannelId,
    } });
    if (!channel) {
      throw Object.assign(new Error("Channel not found"), {
        statusCode: 404,
      });
    }

    const post = await trigger({ function_id: "state::get", payload: {
      scope: `coord_posts:${safeChannelId}`,
      key: safePostId,
    } });
    if (!post) {
      throw Object.assign(new Error("Post not found"), { statusCode: 404 });
    }

    const pinned: string[] = channel.pinned || [];

    if (unpin) {
      channel.pinned = pinned.filter((id: string) => id !== safePostId);
    } else {
      if (pinned.includes(safePostId)) {
        return { channelId: safeChannelId, pinned };
      }
      if (pinned.length >= MAX_PINNED) {
        throw Object.assign(
          new Error(`Maximum ${MAX_PINNED} pinned posts per channel`),
          { statusCode: 400 },
        );
      }
      channel.pinned = [...pinned, safePostId];
    }

    await trigger({ function_id: "state::set", payload: {
      scope: "coord_channels",
      key: safeChannelId,
      value: channel,
    } });

    return { channelId: safeChannelId, pinned: channel.pinned };
  },
);

registerTrigger({
  type: "http",
  function_id: "coord::create_channel",
  config: { api_path: "api/coord/channel", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "coord::post",
  config: { api_path: "api/coord/:channelId/post", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "coord::reply",
  config: { api_path: "api/coord/:channelId/reply", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "coord::list_channels",
  config: { api_path: "api/coord/channels", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "coord::read",
  config: { api_path: "api/coord/:channelId", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "coord::pin",
  config: { api_path: "api/coord/:channelId/pin", http_method: "POST" },
});
