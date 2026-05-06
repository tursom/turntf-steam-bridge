import type { BridgeEnvelope, ConversationRef, MessageRef } from "../model.js";

interface GatewayInboundEvent {
  gatewayMessageId: string;
  envelope: BridgeEnvelope;
}

interface OutboundMessage {
  conversationRef: ConversationRef;
  content: BridgeEnvelope["content"];
  messageRef: MessageRef;
}

interface GatewaySendResult {
  remoteMessageId: string;
}

interface SteamGateway {
  send(msg: OutboundMessage): Promise<GatewaySendResult>;
  close(): void;
}

type GatewayEventCallback = (event: GatewayInboundEvent) => void;

export type { GatewayEventCallback, GatewayInboundEvent, GatewaySendResult, OutboundMessage, SteamGateway };
