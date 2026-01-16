// Utility functions

import type { Bindings } from "./types";

export function coerceToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    const array = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new TextDecoder().decode(array);
  }
  return String(data);
}

export function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function normalizeWorkdirInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function debugEnabled(env: unknown): boolean {
  try {
    const e = env as { DEBUG_LOG?: string } | null;
    const flag = e?.DEBUG_LOG?.toLowerCase?.();
    return flag === "1" || flag === "true" || flag === "debug";
  } catch {
    /* ignored */
  }
  return false;
}

const DEFAULT_AGENT_MANAGER_URL = "http://127.0.0.1:8788";

export function getLocalAgentManagerUrl(env: Bindings): string {
  const raw = env.LOCAL_AGENT_MANAGER_URL;
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed.replace(/\/+$/, "");
    }
  }
  return DEFAULT_AGENT_MANAGER_URL;
}

const DEFAULT_WORKER_CALLBACK_URL = "http://127.0.0.1:8787";

export function getWorkerCallbackBaseUrl(env: Bindings): string {
  // In local dev, use the local worker URL
  // In production, this would be the deployed worker URL
  const raw = (env as unknown as { WORKER_CALLBACK_URL?: string }).WORKER_CALLBACK_URL;
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed.replace(/\/+$/, "");
    }
  }
  return DEFAULT_WORKER_CALLBACK_URL;
}

const DEFAULT_VOICE_WORKER_URL = "https://api-oss.layercode.com";

export function voiceModeDisabled(env: Bindings): boolean {
  const raw = env.DISABLE_VOICE_MODE;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0 || normalized === "false") return false;
    return true;
  }
  return raw === true;
}

/**
 * Builds the voice WebSocket URL for connecting to the external voice worker.
 * Uses api-oss.layercode.com by default, can be overridden with VOICE_WORKER_URL.
 *
 * @param env - Bindings with optional VOICE_WORKER_URL override
 * @param voice - TTS voice ID
 * @returns Full voice ws URL
 */
export function getVoiceWorkerBaseUrl(env: Bindings): string | null {
  if (voiceModeDisabled(env)) return null;
  const raw = env.VOICE_WORKER_URL?.trim();
  if (raw && raw.length > 0) {
    return raw.replace(/\/+$/, "");
  }
  return DEFAULT_VOICE_WORKER_URL;
}

export function buildVoiceWsUrl(env: Bindings, voice: string, agentId: string): string | null {
  const base = getVoiceWorkerBaseUrl(env);
  if (!base) return null;
  return `${base.replace(/^http/, "ws")}/ws?${new URLSearchParams({ voice, agentId }).toString()}`;
}
