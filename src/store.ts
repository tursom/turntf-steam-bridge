import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageCursor } from "@tursom/turntf-js";
import type {
  BridgeEnvelope,
  ConversationRef,
  MessageRef,
  ReceiptCode,
} from "./model.js";
import { conversationKey, newReceiptEnvelope, parseEnvelope } from "./model.js";

const JOB_STATUS_PENDING = "pending";
const JOB_STATUS_PROCESSING = "processing";
const JOB_STATUS_DELIVERED = "delivered";
const JOB_STATUS_FAILED = "failed";

interface BridgeUserRef {
  nodeId: string;
  userId: string;
}

interface TurntfUserRef {
  nodeId: string;
  userId: string;
}

interface GatewayInboundEvent {
  gatewayMessageId: string;
  envelope: BridgeEnvelope;
}

interface OutboundJob {
  id: number;
  sourceCursor: { nodeId: string; seq: string };
  sourceSender: TurntfUserRef;
  conversation: ConversationRef;
  envelope: BridgeEnvelope;
  sourceMessage: MessageRef;
  attempts: number;
  lastErrorCode: string;
  lastErrorText: string;
}

interface TurnTfDeliveryJob {
  id: number;
  jobKey: string;
  kind: string;
  target: TurntfUserRef;
  envelope: BridgeEnvelope;
  attempts: number;
  lastError: string;
}

function backoffForAttempt(attempt: number): number {
  if (attempt <= 1) return 1000;
  const clamped = Math.min(attempt, 6);
  return (1 << (clamped - 1)) * 1000;
}

function fallbackReceiptConversation(): ConversationRef {
  return {
    platform: "steam",
    scene: "private",
    chat_id: "__bridge_receipt__",
  };
}

export class Store {
  private db: Database.Database;
  private bridgeUser: BridgeUserRef;

  constructor(path: string, bridgeUser: BridgeUserRef) {
    if (!path.trim()) {
      throw new Error("sqlite path is required");
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.bridgeUser = bridgeUser;
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.initTables();
  }

  private initTables(): void {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS seen_messages (
        node_id TEXT NOT NULL,
        seq TEXT NOT NULL,
        PRIMARY KEY (node_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS turntf_messages (
        node_id TEXT NOT NULL,
        seq TEXT NOT NULL,
        recipient_node_id TEXT NOT NULL,
        recipient_user_id TEXT NOT NULL,
        sender_node_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        body BLOB NOT NULL,
        created_at_hlc TEXT NOT NULL,
        saved_at_ms INTEGER NOT NULL,
        PRIMARY KEY (node_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS session_bindings (
        bridge_node_id TEXT NOT NULL,
        bridge_user_id TEXT NOT NULL,
        local_node_id TEXT NOT NULL,
        local_user_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        conversation_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (bridge_node_id, bridge_user_id, local_node_id, local_user_id, conversation_key)
      )`,
      `CREATE TABLE IF NOT EXISTS inbound_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gateway_message_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS orphan_inbound_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gateway_message_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS outbound_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_node_id TEXT NOT NULL,
        source_seq TEXT NOT NULL,
        source_sender_node_id TEXT NOT NULL,
        source_sender_user_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        remote_message_id TEXT NOT NULL DEFAULT '',
        last_error_code TEXT NOT NULL DEFAULT '',
        last_error_message TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(source_node_id, source_seq)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outbound_jobs_pending ON outbound_jobs(status, next_attempt_at_ms, id)`,
      `CREATE TABLE IF NOT EXISTS turntf_delivery_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        target_local_node_id TEXT NOT NULL,
        target_local_user_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        last_error_code TEXT NOT NULL DEFAULT '',
        last_error_message TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_turntf_delivery_jobs_pending ON turntf_delivery_jobs(status, next_attempt_at_ms, id)`,
    ];
    for (const stmt of stmts) {
      this.db.exec(stmt);
    }
  }

  close(): void {
    this.db.close();
  }

  loadSeenMessages(): MessageCursor[] {
    const rows = this.db
      .prepare(`SELECT node_id, seq FROM seen_messages ORDER BY node_id, seq`)
      .all() as { node_id: string; seq: string }[];
    return rows.map((r) => ({ nodeId: r.node_id, seq: r.seq }));
  }

  saveMessage(msg: {
    nodeId: string;
    seq: string;
    recipient: TurntfUserRef;
    sender: TurntfUserRef;
    body: Uint8Array;
    createdAtHlc: string;
  }): void {
    const nowMs = Date.now();
    const insertMsg = this.db.prepare(
      `INSERT OR IGNORE INTO turntf_messages (
        node_id, seq, recipient_node_id, recipient_user_id,
        sender_node_id, sender_user_id, body, created_at_hlc, saved_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCursor = this.db.prepare(
      `INSERT OR IGNORE INTO seen_messages (node_id, seq) VALUES (?, ?)`,
    );

    const process = this.db.transaction(() => {
      const result = insertMsg.run(
        msg.nodeId,
        msg.seq,
        msg.recipient.nodeId,
        msg.recipient.userId,
        msg.sender.nodeId,
        msg.sender.userId,
        Buffer.from(msg.body),
        msg.createdAtHlc,
        nowMs,
      );
      if (result.changes === 0) return;
      insertCursor.run(msg.nodeId, msg.seq);

      if (
        msg.recipient.nodeId !== this.bridgeUser.nodeId ||
        msg.recipient.userId !== this.bridgeUser.userId ||
        (msg.sender.nodeId === this.bridgeUser.nodeId &&
          msg.sender.userId === this.bridgeUser.userId)
      ) {
        return;
      }

      let env: BridgeEnvelope;
      try {
        env = parseEnvelope(msg.body);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.enqueueReceipt(
          { nodeId: msg.sender.nodeId, userId: msg.sender.userId },
          fallbackReceiptConversation(),
          { id: `${msg.nodeId}:${msg.seq}` },
          "unsupported_content",
          `bridge message format invalid: ${errMsg}`,
          `receipt:${msg.nodeId}:${msg.seq}:invalid`,
        );
        return;
      }

      if (env.kind !== "chat") {
        this.enqueueReceipt(
          { nodeId: msg.sender.nodeId, userId: msg.sender.userId },
          env.conversation_ref,
          env.message_ref,
          "unsupported_content",
          `bridge message kind "${env.kind}" is not supported for outbound chat`,
          `receipt:${msg.nodeId}:${msg.seq}:kind`,
        );
        return;
      }

      this.upsertBinding(msg.sender, env.conversation_ref, nowMs);

      const envelopeJson = JSON.stringify(env);
      insertJob.run(
        msg.nodeId,
        msg.seq,
        msg.sender.nodeId,
        msg.sender.userId,
        conversationKey(env.conversation_ref),
        envelopeJson,
        JOB_STATUS_PENDING,
        nowMs,
        nowMs,
        nowMs,
      );
    });

    const insertJob = this.db.prepare(
      `INSERT OR IGNORE INTO outbound_jobs (
        source_node_id, source_seq, source_sender_node_id, source_sender_user_id,
        conversation_key, envelope_json, status, attempts, next_attempt_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );

    process();
  }

  saveCursor(cursor: MessageCursor): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO seen_messages (node_id, seq) VALUES (?, ?)`)
      .run(cursor.nodeId, cursor.seq);
  }

  enqueueInboundEvent(event: GatewayInboundEvent): void {
    const nowMs = Date.now();
    if (!event.gatewayMessageId) {
      event.gatewayMessageId = `event:${nowMs}`;
    }

    const envelopeJson = JSON.stringify(event.envelope);
    const convKey = conversationKey(event.envelope.conversation_ref);

    const process = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO inbound_events (
            gateway_message_id, conversation_key, envelope_json, status,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.gatewayMessageId,
          convKey,
          envelopeJson,
          JOB_STATUS_PENDING,
          nowMs,
          nowMs,
        );

      if (result.changes === 0) return;

      const inboundEventId = (
        this.db
          .prepare(`SELECT id FROM inbound_events WHERE gateway_message_id = ?`)
          .get(event.gatewayMessageId) as { id: number } | undefined
      )?.id;
      if (inboundEventId === undefined) return;

      const bindings = this.listBindingsByConversationKey(convKey);
      if (bindings.length === 0) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO orphan_inbound_events (
              gateway_message_id, conversation_key, envelope_json, created_at_ms
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(event.gatewayMessageId, convKey, envelopeJson, nowMs);
        this.db
          .prepare(`UPDATE inbound_events SET status = ?, updated_at_ms = ? WHERE id = ?`)
          .run(JOB_STATUS_FAILED, nowMs, inboundEventId);
        return;
      }

      for (const binding of bindings) {
        const jobKey = `inbound:${inboundEventId}:${binding.nodeId}:${binding.userId}`;
        this.enqueueTurnTfDelivery(jobKey, "inbound", binding, event.envelope);
      }
      this.db
        .prepare(`UPDATE inbound_events SET status = ?, updated_at_ms = ? WHERE id = ?`)
        .run(JOB_STATUS_DELIVERED, nowMs, inboundEventId);
    });

    process();
  }

  enqueueReceipt(
    target: TurntfUserRef,
    conversation: ConversationRef,
    messageRef: MessageRef,
    code: ReceiptCode,
    text: string,
    jobKey: string,
  ): void {
    let conv = conversation;
    try {
      /* validate implicitly via key */
      conversationKey(conv);
    } catch {
      conv = fallbackReceiptConversation();
    }
    const envelope = newReceiptEnvelope(conv, messageRef, code, text);
    this.enqueueTurnTfDelivery(jobKey, "receipt", target, envelope);
  }

  claimOutboundJob(): OutboundJob | null {
    const nowMs = Date.now();
    const claim = this.db.transaction((): OutboundJob | null => {
      const row = this.db
        .prepare(
          `SELECT id, source_node_id, source_seq, source_sender_node_id, source_sender_user_id,
                  envelope_json, attempts, last_error_code, last_error_message
           FROM outbound_jobs
           WHERE status = ? AND next_attempt_at_ms <= ?
           ORDER BY id LIMIT 1`,
        )
        .get(JOB_STATUS_PENDING, nowMs) as
        | {
            id: number;
            source_node_id: string;
            source_seq: string;
            source_sender_node_id: string;
            source_sender_user_id: string;
            envelope_json: string;
            attempts: number;
            last_error_code: string;
            last_error_message: string;
          }
        | undefined;
      if (!row) return null;

      this.db
        .prepare(
          `UPDATE outbound_jobs SET status = ?, attempts = attempts + 1, updated_at_ms = ? WHERE id = ?`,
        )
        .run(JOB_STATUS_PROCESSING, nowMs, row.id);

      const env: BridgeEnvelope = JSON.parse(row.envelope_json);
      return {
        id: row.id,
        sourceCursor: { nodeId: row.source_node_id, seq: row.source_seq },
        sourceSender: {
          nodeId: row.source_sender_node_id,
          userId: row.source_sender_user_id,
        },
        conversation: env.conversation_ref,
        envelope: env,
        sourceMessage: env.message_ref,
        attempts: row.attempts + 1,
        lastErrorCode: row.last_error_code,
        lastErrorText: row.last_error_message,
      };
    });
    return claim();
  }

  claimTurnTfDeliveryJob(): TurnTfDeliveryJob | null {
    const nowMs = Date.now();
    const claim = this.db.transaction((): TurnTfDeliveryJob | null => {
      const row = this.db
        .prepare(
          `SELECT id, job_key, kind, target_local_node_id, target_local_user_id,
                  envelope_json, attempts, last_error_message
           FROM turntf_delivery_jobs
           WHERE status = ? AND next_attempt_at_ms <= ?
           ORDER BY id LIMIT 1`,
        )
        .get(JOB_STATUS_PENDING, nowMs) as
        | {
            id: number;
            job_key: string;
            kind: string;
            target_local_node_id: string;
            target_local_user_id: string;
            envelope_json: string;
            attempts: number;
            last_error_message: string;
          }
        | undefined;
      if (!row) return null;

      this.db
        .prepare(
          `UPDATE turntf_delivery_jobs SET status = ?, attempts = attempts + 1, updated_at_ms = ? WHERE id = ?`,
        )
        .run(JOB_STATUS_PROCESSING, nowMs, row.id);

      const env: BridgeEnvelope = JSON.parse(row.envelope_json);
      return {
        id: row.id,
        jobKey: row.job_key,
        kind: row.kind,
        target: {
          nodeId: row.target_local_node_id,
          userId: row.target_local_user_id,
        },
        envelope: env,
        attempts: row.attempts + 1,
        lastError: row.last_error_message,
      };
    });
    return claim();
  }

  markOutboundDelivered(id: number, remoteMessageId: string): void {
    this.db
      .prepare(
        `UPDATE outbound_jobs SET status = ?, remote_message_id = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(JOB_STATUS_DELIVERED, remoteMessageId, Date.now(), id);
  }

  retryOutbound(id: number, code: string, message: string, attempts: number): void {
    this.db
      .prepare(
        `UPDATE outbound_jobs
         SET status = ?, next_attempt_at_ms = ?, updated_at_ms = ?,
             last_error_code = ?, last_error_message = ?
         WHERE id = ?`,
      )
      .run(
        JOB_STATUS_PENDING,
        Date.now() + backoffForAttempt(attempts),
        Date.now(),
        code,
        message,
        id,
      );
  }

  failOutbound(id: number, code: string, message: string): void {
    this.db
      .prepare(
        `UPDATE outbound_jobs
         SET status = ?, updated_at_ms = ?, last_error_code = ?, last_error_message = ?
         WHERE id = ?`,
      )
      .run(JOB_STATUS_FAILED, Date.now(), code, message, id);
  }

  markTurnTfDeliveryDelivered(id: number): void {
    this.db
      .prepare(`UPDATE turntf_delivery_jobs SET status = ?, updated_at_ms = ? WHERE id = ?`)
      .run(JOB_STATUS_DELIVERED, Date.now(), id);
  }

  retryTurnTfDelivery(id: number, code: string, message: string, attempts: number): void {
    this.db
      .prepare(
        `UPDATE turntf_delivery_jobs
         SET status = ?, next_attempt_at_ms = ?, updated_at_ms = ?,
             last_error_code = ?, last_error_message = ?
         WHERE id = ?`,
      )
      .run(
        JOB_STATUS_PENDING,
        Date.now() + backoffForAttempt(attempts),
        Date.now(),
        code,
        message,
        id,
      );
  }

  failTurnTfDelivery(id: number, code: string, message: string): void {
    this.db
      .prepare(
        `UPDATE turntf_delivery_jobs
         SET status = ?, updated_at_ms = ?, last_error_code = ?, last_error_message = ?
         WHERE id = ?`,
      )
      .run(JOB_STATUS_FAILED, Date.now(), code, message);
  }

  private upsertBinding(
    sender: TurntfUserRef,
    conversation: ConversationRef,
    nowMs: number,
  ): void {
    const convJson = JSON.stringify(conversation);
    this.db
      .prepare(
        `INSERT INTO session_bindings (
          bridge_node_id, bridge_user_id, local_node_id, local_user_id,
          conversation_key, conversation_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bridge_node_id, bridge_user_id, local_node_id, local_user_id, conversation_key)
        DO UPDATE SET conversation_json = excluded.conversation_json, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        this.bridgeUser.nodeId,
        this.bridgeUser.userId,
        sender.nodeId,
        sender.userId,
        conversationKey(conversation),
        convJson,
        nowMs,
        nowMs,
      );
  }

  private listBindingsByConversationKey(convKey: string): TurntfUserRef[] {
    const rows = this.db
      .prepare(
        `SELECT local_node_id, local_user_id
         FROM session_bindings
         WHERE bridge_node_id = ? AND bridge_user_id = ? AND conversation_key = ?
         ORDER BY local_node_id, local_user_id`,
      )
      .all(this.bridgeUser.nodeId, this.bridgeUser.userId, convKey) as {
      local_node_id: string;
      local_user_id: string;
    }[];
    return rows.map((r) => ({ nodeId: r.local_node_id, userId: r.local_user_id }));
  }

  private enqueueTurnTfDelivery(
    jobKey: string,
    kind: string,
    target: TurntfUserRef,
    envelope: BridgeEnvelope,
  ): void {
    const envelopeJson = JSON.stringify(envelope);
    const nowMs = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO turntf_delivery_jobs (
          job_key, kind, target_local_node_id, target_local_user_id,
          envelope_json, status, attempts, next_attempt_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        jobKey,
        kind,
        target.nodeId,
        target.userId,
        envelopeJson,
        JOB_STATUS_PENDING,
        nowMs,
        nowMs,
        nowMs,
      );
  }
}
