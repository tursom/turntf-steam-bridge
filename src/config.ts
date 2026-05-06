import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";

interface StorageConfig {
  sqlite_path: string;
}

interface TurnTFConfig {
  base_url: string;
  bridge_user: BridgeUserConfig;
}

interface BridgeUserConfig {
  node_id: number;
  user_id: number;
  password: {
    source: "plain" | "hashed";
    value: string;
  };
}

interface BackendConfig {
  steam: SteamConfig;
}

interface SteamConfig {
  account_name: string;
  password: string;
  sentry_path: string;
  auth_code?: string;
  proxy?: string;
  steam_id?: string;
  logon_id?: number;
}

interface Config {
  storage: StorageConfig;
  turntf: TurnTFConfig;
  backend: BackendConfig;
}

const defaultSentryPath = "sentry.bin";

function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf-8");
  const cfg = parseYaml(raw) as Config;

  applyDefaults(cfg, configPath);
  validateConfig(cfg);

  return cfg;
}

function applyDefaults(cfg: Config, configPath: string): void {
  if (!cfg.storage) cfg.storage = {} as StorageConfig;
  if (!cfg.storage.sqlite_path) {
    cfg.storage.sqlite_path = "./steam-bridge.sqlite";
  }
  if (!cfg.storage.sqlite_path.startsWith("/")) {
    cfg.storage.sqlite_path = resolve(dirname(configPath), cfg.storage.sqlite_path);
  }
  if (!cfg.backend.steam.sentry_path) {
    cfg.backend.steam.sentry_path = resolve(dirname(configPath), defaultSentryPath);
  }
}

function validateConfig(cfg: Config): void {
  if (!cfg.storage.sqlite_path?.trim()) {
    throw new Error("storage.sqlite_path is required");
  }
  if (!cfg.turntf?.base_url?.trim()) {
    throw new Error("turntf.base_url is required");
  }
  const bu = cfg.turntf?.bridge_user;
  if (!bu || !bu.node_id || !bu.user_id) {
    throw new Error("turntf.bridge_user.node_id and user_id are required (non-zero)");
  }
  if (!bu.password?.value?.trim()) {
    throw new Error("turntf.bridge_user.password is required");
  }
  if (bu.password.source !== "plain" && bu.password.source !== "hashed") {
    throw new Error('turntf.bridge_user.password.source must be "plain" or "hashed"');
  }
  const steam = cfg.backend?.steam;
  if (!steam) {
    throw new Error("backend.steam is required");
  }
  if (!steam.account_name?.trim()) {
    throw new Error("backend.steam.account_name is required");
  }
  if (!steam.password?.trim()) {
    throw new Error("backend.steam.password is required");
  }
}

export { loadConfig };
export type { BridgeUserConfig, Config, SteamConfig, StorageConfig, TurnTFConfig };
