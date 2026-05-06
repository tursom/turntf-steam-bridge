import type { ReceiptCode } from "./model.js";

class BridgeError extends Error {
  readonly code: ReceiptCode;
  readonly retryable: boolean;

  constructor(code: ReceiptCode, message: string, retryable: boolean, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = retryable;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function retryableBridgeError(code: ReceiptCode, message: string, cause?: unknown): BridgeError {
  return new BridgeError(code, message, true, cause);
}

function terminalBridgeError(code: ReceiptCode, message: string, cause?: unknown): BridgeError {
  return new BridgeError(code, message, false, cause);
}

function classifyBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return retryableBridgeError("platform_unavailable", `steam gateway error: ${message}`, err);
}

export { BridgeError, classifyBridgeError, retryableBridgeError, terminalBridgeError };
