import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";
import type { Logger } from "winston";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { BridgeEnvelope, ConversationRef, Segment } from "../model.js";
import { normalizeAndValidateEnvelope } from "../model.js";
import { retryableBridgeError, terminalBridgeError } from "../errors.js";
import type { GatewayEventCallback, GatewaySendResult, OutboundMessage, SteamGateway } from "./interface.js";

const ENVELOPE_VERSION = "v1alpha1";

const DEFAULT_INITIAL_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

interface SteamGatewayConfig {
  accountName: string;
  password: string;
  sentryPath: string;
  authCode?: string;
  proxy?: string;
  steamID?: string;
  logonID?: number;
}

function createSteamGateway(
  cfg: SteamGatewayConfig,
  logger: Logger,
  onEvent: GatewayEventCallback,
): SteamGateway {
  const steamUser = new SteamUser({
    autoRelogin: true,
    dataDirectory: dirname(cfg.sentryPath),
  });
  const community = new SteamCommunity();

  let retryDelayMs = DEFAULT_INITIAL_RETRY_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let loginResolved = false;
  let loggedOn = false;

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function logOn(reason: string): void {
    const options: Record<string, unknown> = {
      logonID: cfg.logonID ?? Math.floor(Math.random() * (999999999 - 1000000) + 1000000),
    };

    try {
      const refreshToken = readFileSync("refresh.token", "utf-8").trim();
      if (refreshToken && cfg.steamID) {
        options.refreshToken = refreshToken;
        options.steamID = cfg.steamID;
        logger.info("steam logon via refresh token", { reason, steamID: cfg.steamID });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        steamUser.logOn(options as any);
        return;
      }
    } catch {
      /* no refresh token, use credentials */
    }

    options.accountName = cfg.accountName;
    options.password = cfg.password;
    if (cfg.authCode) {
      options.authCode = cfg.authCode;
    }
    if (cfg.steamID) {
      options.steamID = cfg.steamID;
    }

    logger.info("steam logon via credentials", { reason, accountName: cfg.accountName });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steamUser.logOn(options as any);
  }

  function scheduleRetry(err: Error): void {
    if (retryTimer) {
      logger.warn("steam reconnect already scheduled", { delayMs: retryDelayMs });
      return;
    }
    const delayMs = retryDelayMs;
    logger.warn("steam reconnect scheduled", { delayMs, error: err.message });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelayMs = Math.min(retryDelayMs * 2, DEFAULT_MAX_RETRY_DELAY_MS);
      try {
        logOn("retry");
      } catch (retryErr: unknown) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        logger.error("steam reconnect attempt failed to start", { error: msg });
        scheduleRetry(new Error(msg));
      }
    }, delayMs);
  }

  steamUser.setOption("renewRefreshTokens", true);

  steamUser.on("refreshToken", (refreshToken: string) => {
    logger.info("steam refresh token received");
    try {
      writeFileSync("refresh.token", refreshToken);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("failed to write steam refresh token", { error: msg });
    }
  });

  steamUser.on("loggedOn", () => {
    clearRetryTimer();
    retryDelayMs = DEFAULT_INITIAL_RETRY_DELAY_MS;
    loginResolved = true;
    loggedOn = true;
    const steamID = steamUser.steamID?.getSteamID64?.() ?? "unknown";
    logger.info(`steam logged on as ${steamID}`);
    try {
      steamUser.webLogOn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`failed to start web login: ${msg}`);
    }
  });

  steamUser.on("disconnected", (eresult: number, msg?: string) => {
    logger.warn("steam disconnected", { eresult, message: msg ?? "" });
  });

  steamUser.on("error", (err: Error & { eresult?: number }) => {
    const recoverable = isRecoverableSteamError(err);
    logger.error("steam error", {
      error: err.message,
      eresult: err.eresult,
      recoverable,
    });
    if (recoverable) {
      scheduleRetry(err);
    } else if (!loginResolved) {
      clearRetryTimer();
    }
  });

  steamUser.on("webSession", (_sessionID: string, cookies: string[]) => {
    logger.info("steam web session received");
    community.setCookies(cookies);
  });

  steamUser.chat.on(
    "friendMessage",
    (msg: {
      steamid_friend: { getSteamID64: () => string };
      message: string;
      ordinal: number;
    }) => {
      const friendID = msg.steamid_friend.getSteamID64();
      logger.info("steam friend message received", { friendID, ordinal: msg.ordinal });

      const conversation: ConversationRef = {
        platform: "steam",
        scene: "private",
        chat_id: friendID,
      };

      let segments: Segment[];
      try {
        const parsed = JSON.parse(msg.message);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.segments)) {
          segments = parsed.segments;
        } else {
          segments = [{ kind: "text", text: msg.message }];
        }
      } catch {
        segments = [{ kind: "text", text: msg.message }];
      }

      const envelope: BridgeEnvelope = {
        version: ENVELOPE_VERSION,
        kind: "chat",
        conversation_ref: conversation,
        content: { segments },
        remote_sender: {
          id: friendID,
          nickname: "",
        },
        message_ref: {
          id: `${friendID}:${msg.ordinal}`,
        },
        metadata: {
          platform: "steam",
          scene: "private",
          ordinal: msg.ordinal,
        },
      };

      try {
        normalizeAndValidateEnvelope(envelope);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("steam gateway normalize event failed", { error: msg });
        return;
      }

      onEvent({
        gatewayMessageId: `${friendID}:${msg.ordinal}`,
        envelope,
      });

      steamUser.getPersonas([friendID]).then((result) => {
        const persona = result?.personas?.[friendID];
        if (persona) {
          envelope.remote_sender = {
            id: friendID,
            nickname: persona.player_name || "",
            avatar_url: persona.avatar_url_medium || "",
          };
          onEvent({
            gatewayMessageId: `${friendID}:${msg.ordinal}:enriched`,
            envelope,
          });
        }
      }).catch(() => {
        /* persona fetch is best-effort */
      });
    },
  );

  if (cfg.proxy) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (steamUser.setOption as any)("proxy", cfg.proxy);
    } catch {
      logger.warn("failed to set steam proxy", { proxy: cfg.proxy });
    }
  }

  logOn("initial");

  const gateway: SteamGateway = {
    async send(msg: OutboundMessage): Promise<GatewaySendResult> {
      const friendID = msg.conversationRef.chat_id;
      const text = msg.content.segments
        .filter((s: Segment) => s.kind === "text")
        .map((s: Segment) => s.text || "")
        .join("");

      if (!text.trim()) {
        throw terminalBridgeError(
          "unsupported_content",
          "steam chat message has no text content",
        );
      }

      try {
        return await new Promise<GatewaySendResult>((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (steamUser.chat.sendFriendMessage as any)(friendID, text, (err: Error, response: { modified_message?: boolean; ordinal?: number }) => {
            if (err) {
              reject(mapSteamSendError(err));
              return;
            }
            resolve({
              remoteMessageId: response?.modified_message
                ? `${friendID}:${response.ordinal ?? "unknown"}`
                : `${friendID}:sent`,
            });
          });
        });
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw retryableBridgeError("platform_unavailable", `steam send failed: ${msg}`, err);
      }
    },

    close(): void {
      clearRetryTimer();
      steamUser.removeAllListeners();
      try {
        steamUser.logOff();
      } catch {
        /* ignore */
      }
    },
  };

  return gateway;
}

function isRecoverableSteamError(err: Error & { eresult?: number }): boolean {
  if (!err) return true;

  const message = String(err.message || err);

  const nonRecoverablePatterns = [
    /invalid password/i,
    /invalid refresh token/i,
    /not valid for logging in/i,
    /steam guard/i,
    /two[- ]?factor/i,
    /account login denied/i,
    /logged in elsewhere/i,
    /banned/i,
    /suspended/i,
  ];
  if (nonRecoverablePatterns.some((p) => p.test(message))) {
    return false;
  }

  const recoverablePatterns = [
    /no steam servers available/i,
    /no connection/i,
    /service unavailable/i,
    /try another cm/i,
    /timeout/i,
    /timed out/i,
    /econnreset/i,
    /econnrefused/i,
    /enotfound/i,
    /eai_again/i,
    /socket/i,
    /tls/i,
    /network/i,
    /rate limit/i,
  ];
  if (recoverablePatterns.some((p) => p.test(message))) {
    return true;
  }

  return true;
}

function mapSteamSendError(err: Error): Error {
  const message = err.message || "";
  if (/rate limit|429/i.test(message)) {
    return retryableBridgeError("rate_limited", `steam rate limited: ${message}`, err);
  }
  if (/not friend/i.test(message)) {
    return terminalBridgeError("target_not_found", `steam target is not a friend: ${message}`, err);
  }
  if (/blocked|ignore/i.test(message)) {
    return terminalBridgeError("permission_denied", `steam message blocked: ${message}`, err);
  }
  return retryableBridgeError("platform_unavailable", `steam send error: ${message}`, err);
}

export { createSteamGateway };
