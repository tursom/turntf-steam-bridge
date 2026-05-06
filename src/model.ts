const ENVELOPE_VERSION = "v1alpha1" as const;

type EnvelopeKind = "chat" | "system" | "receipt";

type ConversationScene = "private";

type SegmentKind = "text" | "image" | "json";

interface BridgeEnvelope {
  version: string;
  kind: EnvelopeKind;
  conversation_ref: ConversationRef;
  content: Content;
  remote_sender?: RemoteSender;
  message_ref: MessageRef;
  metadata?: Metadata;
}

interface ConversationRef {
  platform: string;
  scene: ConversationScene;
  chat_id: string;
  thread_id?: string;
}

interface Content {
  segments: Segment[];
}

interface Segment {
  kind: SegmentKind;
  text?: string;
  url?: string;
  file_name?: string;
  mime?: string;
  message_id?: string;
  user_id?: string;
  payload?: unknown;
}

interface RemoteSender {
  id: string;
  nickname: string;
  remark?: string;
  avatar_url?: string;
}

interface MessageRef {
  id: string;
  reply_to?: string;
}

type Metadata = Record<string, unknown>;

type ReceiptCode =
  | "platform_unavailable"
  | "target_not_found"
  | "permission_denied"
  | "unsupported_content"
  | "rate_limited"
  | "delivery_failed";

function normalizeAndValidateEnvelope(env: BridgeEnvelope): void {
  if (!env) {
    throw new Error("bridge envelope is required");
  }
  if (!env.version) {
    env.version = ENVELOPE_VERSION;
  }
  if (env.version !== ENVELOPE_VERSION) {
    throw new Error(`unsupported bridge envelope version "${env.version}"`);
  }
  const validKinds: EnvelopeKind[] = ["chat", "system", "receipt"];
  if (!validKinds.includes(env.kind)) {
    throw new Error(`unsupported bridge envelope kind "${env.kind}"`);
  }
  normalizeAndValidateConversationRef(env.conversation_ref);
  normalizeAndValidateContent(env.content);
}

function normalizeAndValidateConversationRef(ref: ConversationRef): void {
  if (!ref) {
    throw new Error("conversation_ref is required");
  }
  ref.platform = (ref.platform || "").trim();
  if (!ref.platform) {
    ref.platform = "steam";
  }
  if (ref.scene !== "private") {
    throw new Error(`unsupported conversation_ref.scene "${ref.scene}"`);
  }
  ref.chat_id = (ref.chat_id || "").trim();
  if (!ref.chat_id) {
    throw new Error("conversation_ref.chat_id is required");
  }
  ref.thread_id = (ref.thread_id || "").trim() || undefined;
}

function normalizeAndValidateContent(content: Content): void {
  if (!content) {
    throw new Error("content is required");
  }
  if (!content.segments || content.segments.length === 0) {
    throw new Error("content.segments is required");
  }
  for (let i = 0; i < content.segments.length; i++) {
    normalizeAndValidateSegment(content.segments[i]!, i);
  }
}

function normalizeAndValidateSegment(segment: Segment, index: number): void {
  if (!segment) {
    throw new Error(`segment is required at index ${index}`);
  }
  switch (segment.kind) {
    case "text":
      if (!(segment.text || "").trim()) {
        throw new Error(`text segment at index ${index} requires text`);
      }
      break;
    case "image":
      if (!(segment.url || "").trim()) {
        throw new Error(`image segment at index ${index} requires url`);
      }
      break;
    case "json":
      if (segment.payload === undefined || segment.payload === null) {
        throw new Error(`json segment at index ${index} requires payload`);
      }
      break;
    default:
      throw new Error(`unsupported segment kind "${segment.kind}" at index ${index}`);
  }
}

function conversationKey(ref: ConversationRef): string {
  const threadID = ref.thread_id || "-";
  return [ref.platform, ref.scene, ref.chat_id, threadID].join("|");
}

function conversationMatches(
  ref: ConversationRef,
  pattern: ConversationRef,
): boolean {
  if (ref.platform !== pattern.platform) return false;
  if (ref.scene !== pattern.scene) return false;
  if (pattern.chat_id && ref.chat_id !== pattern.chat_id) return false;
  if (pattern.thread_id && ref.thread_id !== pattern.thread_id) return false;
  return true;
}

function withConversation(
  env: BridgeEnvelope,
  conv: ConversationRef,
): BridgeEnvelope {
  return { ...env, conversation_ref: conv };
}

function textSummary(content: Content): string {
  return content.segments
    .filter((s) => s.kind === "text")
    .map((s) => s.text || "")
    .join("");
}

function newReceiptEnvelope(
  conversation: ConversationRef,
  messageRef: MessageRef,
  code: ReceiptCode,
  text: string,
): BridgeEnvelope {
  return {
    version: ENVELOPE_VERSION,
    kind: "receipt",
    conversation_ref: conversation,
    message_ref: messageRef,
    content: {
      segments: [{ kind: "text", text }],
    },
    metadata: { code },
  };
}

function parseEnvelope(data: Uint8Array): BridgeEnvelope {
  const text = new TextDecoder().decode(data);
  const env: BridgeEnvelope = JSON.parse(text);
  normalizeAndValidateEnvelope(env);
  return env;
}

export {
  ENVELOPE_VERSION,
  conversationKey,
  conversationMatches,
  newReceiptEnvelope,
  normalizeAndValidateEnvelope,
  parseEnvelope,
  textSummary,
  withConversation,
};
export type {
  BridgeEnvelope,
  Content,
  ConversationRef,
  ConversationScene,
  EnvelopeKind,
  MessageRef,
  Metadata,
  ReceiptCode,
  RemoteSender,
  Segment,
  SegmentKind,
};
