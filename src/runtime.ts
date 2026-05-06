import {
  Client,
  NopHandler,
  plainPasswordSync,
  hashedPassword,
  DisconnectedError,
  NotConnectedError,
  ClosedError,
  ServerError,
  type LoginInfo,
  type Message,
  type Packet,
} from "@tursom/turntf-js";
import type { Logger } from "winston";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { classifyBridgeError, BridgeError } from "./errors.js";
import { createSteamGateway } from "./gateway/steam-gateway.js";
import type { OutboundMessage, GatewayInboundEvent } from "./gateway/interface.js";

const SLEEP_POLL_MS = 500;
const SLEEP_ERROR_MS = 1000;

export class Runtime extends NopHandler {
  private cfg: Config;
  private logger: Logger;
  private store: Store;
  private gateway: ReturnType<typeof createSteamGateway>;
  private client!: Client;
  private bridgeUser: { nodeId: string; userId: string };
  private stopped = false;

  constructor(cfg: Config, logger: Logger) {
    super();
    this.cfg = cfg;
    this.logger = logger;

    const bridgeNodeId = String(cfg.turntf.bridge_user.node_id);
    const bridgeUserId = String(cfg.turntf.bridge_user.user_id);
    this.bridgeUser = { nodeId: bridgeNodeId, userId: bridgeUserId };

    this.store = new Store(cfg.storage.sqlite_path, this.bridgeUser, cfg.relay);

    this.gateway = createSteamGateway(
      {
        accountName: cfg.backend.steam.account_name,
        password: cfg.backend.steam.password,
        sentryPath: cfg.backend.steam.sentry_path,
        authCode: cfg.backend.steam.auth_code,
        proxy: cfg.backend.steam.proxy,
        steamID: cfg.backend.steam.steam_id,
        logonID: cfg.backend.steam.logon_id,
      },
      logger,
      (event: GatewayInboundEvent) => {
        try {
          this.store.enqueueInboundEvent(event);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("steambridge enqueue inbound event failed", { error: msg });
        }
      },
    );

    const password = this.cfg.turntf.bridge_user.password;
    const passwordInput =
      password.source === "plain"
        ? plainPasswordSync(password.value)
        : hashedPassword(password.value);

    this.client = new Client({
      baseUrl: cfg.turntf.base_url,
      credentials: {
        nodeId: bridgeNodeId,
        userId: bridgeUserId,
        password: passwordInput,
      },
      cursorStore: this.store,
      handler: this,
      initialReconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      requestTimeoutMs: 10000,
      pingIntervalMs: 30000,
    });
  }

  override onLogin(_info: LoginInfo): void {
    this.logger.info(
      `steambridge turntf login ok: session=${_info.sessionRef.servingNodeId}/${_info.sessionRef.sessionId} protocol=${_info.protocolVersion}`,
    );
  }

  override onMessage(msg: Message): void {
    this.logger.info(
      `steambridge observed turntf message: cursor=${msg.nodeId}/${msg.seq} sender=${msg.sender.nodeId}:${msg.sender.userId} recipient=${msg.recipient.nodeId}:${msg.recipient.userId}`,
    );
  }

  override onPacket(packet: Packet): void {
    this.logger.info(
      `steambridge ignored transient packet: packet=${packet.packetId} target=${packet.recipient.nodeId}:${packet.recipient.userId}`,
    );
  }

  override onError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`steambridge turntf error: ${msg}`);
  }

  override onDisconnect(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.warn(`steambridge turntf disconnected: ${msg}`);
  }

  async start(): Promise<void> {
    await this.client.connect();
    this.logger.info(
      `steambridge connected to turntf as ${this.bridgeUser.nodeId}:${this.bridgeUser.userId}`,
    );

    const runOutbound = this.runOutboundLoop.bind(this);
    const runDelivery = this.runTurntfDeliveryLoop.bind(this);

    void runOutbound().catch((err: unknown) => {
      if (!this.stopped) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`steambridge outbound loop crashed: ${msg}`);
      }
    });
    void runDelivery().catch((err: unknown) => {
      if (!this.stopped) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`steambridge turntf delivery loop crashed: ${msg}`);
      }
    });

    this.logger.info("steambridge runtime started");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.gateway.close();
    } catch {
      /* ignore */
    }
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
    try {
      this.store.close();
    } catch {
      /* ignore */
    }
    this.logger.info("steambridge runtime stopped");
  }

  private async runOutboundLoop(): Promise<void> {
    while (!this.stopped) {
      let job;
      try {
        job = this.store.claimOutboundJob();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`steambridge claim outbound job failed: ${msg}`);
        await this.sleep(SLEEP_ERROR_MS);
        continue;
      }

      if (!job) {
        await this.sleep(SLEEP_POLL_MS);
        continue;
      }

      const segments = job.envelope.content.segments;
      if (segments.length === 0) {
        this.store.failOutbound(job.id, "unsupported_content", "message has no segments");
        continue;
      }

      const outboundMsg: OutboundMessage = {
        conversationRef: job.conversation,
        content: job.envelope.content,
        messageRef: job.sourceMessage,
      };

      try {
        const result = await this.gateway.send(outboundMsg);
        this.store.markOutboundDelivered(job.id, result.remoteMessageId);
        this.logger.info(
          `steambridge outbound delivered: job=${job.id} steam_msg=${result.remoteMessageId} to=${job.conversation.chat_id}`,
        );
      } catch (err: unknown) {
        const bridgeErr = classifyBridgeError(err);
        if (bridgeErr.retryable) {
          this.store.retryOutbound(job.id, bridgeErr.code, bridgeErr.message, job.attempts);
          this.logger.warn(
            `steambridge outbound retry: job=${job.id} code=${bridgeErr.code} attempts=${job.attempts}`,
          );
        } else {
          this.store.failOutbound(job.id, bridgeErr.code, bridgeErr.message);
          this.store.enqueueReceipt(
            job.sourceSender,
            job.conversation,
            job.sourceMessage,
            bridgeErr.code,
            bridgeErr.message,
            `receipt:${job.sourceCursor.nodeId}:${job.sourceCursor.seq}:delivery`,
          );
          this.logger.warn(
            `steambridge outbound failed: job=${job.id} code=${bridgeErr.code} msg=${bridgeErr.message}`,
          );
        }
      }
    }
  }

  private async runTurntfDeliveryLoop(): Promise<void> {
    while (!this.stopped) {
      let job;
      try {
        job = this.store.claimTurnTfDeliveryJob();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`steambridge claim turntf delivery job failed: ${msg}`);
        await this.sleep(SLEEP_ERROR_MS);
        continue;
      }

      if (!job) {
        await this.sleep(SLEEP_POLL_MS);
        continue;
      }

      try {
        const body = new TextEncoder().encode(JSON.stringify(job.envelope));
        await this.client.sendMessage(job.target, body);
        this.store.markTurnTfDeliveryDelivered(job.id);
        this.logger.info(
          `steambridge turntf delivery delivered: job=${job.id} to=${job.target.nodeId}:${job.target.userId} kind=${job.kind}`,
        );
      } catch (err: unknown) {
        const bridgeErr = classifyTurntfSendError(err);
        if (bridgeErr.retryable) {
          this.store.retryTurnTfDelivery(
            job.id,
            bridgeErr.code,
            bridgeErr.message,
            job.attempts,
          );
          this.logger.warn(
            `steambridge turntf delivery retry: job=${job.id} code=${bridgeErr.code} attempts=${job.attempts}`,
          );
        } else {
          this.store.failTurnTfDelivery(job.id, bridgeErr.code, bridgeErr.message);
          this.logger.warn(
            `steambridge turntf delivery failed: job=${job.id} code=${bridgeErr.code} msg=${bridgeErr.message}`,
          );
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function classifyTurntfSendError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  if (err instanceof DisconnectedError || err instanceof NotConnectedError || err instanceof ClosedError) {
    return new BridgeError("platform_unavailable", "turntf bridge user is offline", true, err);
  }
  if (err instanceof ServerError) {
    switch (err.code) {
      case "not_found":
        return new BridgeError("target_not_found", "turntf target user not found", false, err);
      case "forbidden":
      case "unauthorized":
        return new BridgeError("permission_denied", "turntf delivery forbidden", false, err);
      default:
        return new BridgeError("delivery_failed", "turntf send_message failed", true, err);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("unauthorized")) {
    return new BridgeError("permission_denied", "turntf delivery forbidden", false, err);
  }
  return new BridgeError("platform_unavailable", "turntf send_message unavailable", true, err);
}
