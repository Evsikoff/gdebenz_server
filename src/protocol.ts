import type { City, EntitySnapshot, LeaderboardEntry, PlayerInput, PublicPlayerState } from "./types.js";

export const PROTOCOL_VERSION = 1 as const;

export type ObjectType = "billboard" | "station" | "canister" | "base";

export type ClientMessage =
  | { type: "player:join"; payload: { name: string } }
  | { type: "player:input"; payload: PlayerInput & { seq: number; worldRevision: number } }
  | {
      type: "player:move";
      payload: { seq: number; worldRevision: number; x: number; y: number; angle: number; speed: number };
    }
  | {
      type: "world:interact";
      payload: { requestId: string; objectType: ObjectType; objectId: string; amount?: number };
    }
  | {
      type: "player:fuel-filled";
      payload: { requestId: string; stationId: string; liters: number };
    }
  | {
      type: "station:blocked";
      payload: { requestId: string; stationId: string };
    }
  | {
      type: "billboard:interacted";
      payload: { requestId: string; billboardId: string };
    }
  | {
      type: "player:lost";
      payload: { requestId: string; reason?: string };
    }
  | {
      type: "player:respawn";
      payload: { requestId: string };
    }
  | { type: "ping"; payload: { clientTime?: number } };

export type ServerMessage =
  | {
      type: "server:hello";
      payload: { protocolVersion: typeof PROTOCOL_VERSION; tickRate: number; snapshotRate: number };
    }
  | { type: "player:welcome"; payload: { playerId: string; player: PublicPlayerState } }
  | { type: "world:snapshot"; payload: { map: City; entities: EntitySnapshot; leaderboard: LeaderboardEntry[] } }
  | {
      type: "world:map-update";
      payload: { map: City; reason: "player-count"; fuelBonus: number; affectedPlayers: string[] };
    }
  | { type: "world:entities"; payload: EntitySnapshot }
  | { type: "world:objects"; payload: { worldRevision: number; stations: City["stations"]; billboards: City["billboards"]; canisters: City["canisters"] } }
  | { type: "player:joined"; payload: { player: PublicPlayerState; botCount: number } }
  | { type: "player:left"; payload: { playerId: string; botCount: number } }
  | { type: "player:despawned"; payload: { playerId: string; reason: string } }
  | { type: "player:respawned"; payload: { player: PublicPlayerState } }
  | { type: "leaderboard:update"; payload: { rows: LeaderboardEntry[] } }
  | {
      type: "interaction:result";
      payload: { requestId: string; ok: boolean; code: string; player: PublicPlayerState; details?: Record<string, unknown> };
    }
  | {
      type: "game:event-result";
      payload: {
        requestId: string;
        event: "fuel-filled" | "station-blocked" | "billboard-interacted" | "player-lost" | "player-respawn";
        ok: boolean;
        code: string;
        player: PublicPlayerState;
        details?: Record<string, unknown>;
      };
    }
  | { type: "server:error"; payload: { code: string; message: string; requestId?: string } }
  | { type: "pong"; payload: { clientTime?: number; serverTime: number } };

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function requiredString(record: JsonRecord, key: string, maxLength: number): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

export function parseClientMessage(raw: string): { ok: true; value: ClientMessage } | { ok: false; error: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "Message is not valid JSON" };
  }
  if (!isRecord(decoded) || typeof decoded.type !== "string" || !isRecord(decoded.payload)) {
    return { ok: false, error: "Message must contain string type and object payload" };
  }
  const payload = decoded.payload;

  switch (decoded.type) {
    case "player:join": {
      const name = requiredString(payload, "name", 24);
      return name ? { ok: true, value: { type: decoded.type, payload: { name } } } : { ok: false, error: "Invalid player name" };
    }
    case "player:input": {
      if (
        !isSequence(payload.seq) ||
        !isSequence(payload.worldRevision) ||
        typeof payload.up !== "boolean" ||
        typeof payload.down !== "boolean" ||
        typeof payload.left !== "boolean" ||
        typeof payload.right !== "boolean" ||
        typeof payload.handbrake !== "boolean"
      ) {
        return { ok: false, error: "Invalid player input" };
      }
      return {
        ok: true,
        value: {
          type: decoded.type,
          payload: {
            seq: payload.seq,
            worldRevision: payload.worldRevision,
            up: payload.up,
            down: payload.down,
            left: payload.left,
            right: payload.right,
            handbrake: payload.handbrake,
          },
        },
      };
    }
    case "player:move": {
      if (
        !isSequence(payload.seq) ||
        !isSequence(payload.worldRevision) ||
        !isFiniteNumber(payload.x) ||
        !isFiniteNumber(payload.y) ||
        !isFiniteNumber(payload.angle) ||
        !isFiniteNumber(payload.speed)
      ) {
        return { ok: false, error: "Invalid player movement" };
      }
      return {
        ok: true,
        value: {
          type: decoded.type,
          payload: {
            seq: payload.seq,
            worldRevision: payload.worldRevision,
            x: payload.x,
            y: payload.y,
            angle: payload.angle,
            speed: payload.speed,
          },
        },
      };
    }
    case "world:interact": {
      const requestId = requiredString(payload, "requestId", 64);
      const objectId = requiredString(payload, "objectId", 64);
      const allowedTypes: ObjectType[] = ["billboard", "station", "canister", "base"];
      if (!requestId || !objectId || !allowedTypes.includes(payload.objectType as ObjectType)) {
        return { ok: false, error: "Invalid interaction" };
      }
      if (payload.amount !== undefined && (!isFiniteNumber(payload.amount) || payload.amount < 0)) {
        return { ok: false, error: "Invalid interaction amount" };
      }
      const interactionPayload: Extract<ClientMessage, { type: "world:interact" }>["payload"] = {
        requestId,
        objectType: payload.objectType as ObjectType,
        objectId,
      };
      if (typeof payload.amount === "number") interactionPayload.amount = payload.amount;
      return { ok: true, value: { type: decoded.type, payload: interactionPayload } };
    }
    case "player:fuel-filled": {
      const requestId = requiredString(payload, "requestId", 64);
      const stationId = requiredString(payload, "stationId", 64);
      if (!requestId || !stationId || !isFiniteNumber(payload.liters) || payload.liters <= 0) {
        return { ok: false, error: "Invalid fuel-filled event" };
      }
      return {
        ok: true,
        value: { type: decoded.type, payload: { requestId, stationId, liters: payload.liters } },
      };
    }
    case "station:blocked": {
      const requestId = requiredString(payload, "requestId", 64);
      const stationId = requiredString(payload, "stationId", 64);
      return requestId && stationId
        ? { ok: true, value: { type: decoded.type, payload: { requestId, stationId } } }
        : { ok: false, error: "Invalid station-blocked event" };
    }
    case "billboard:interacted": {
      const requestId = requiredString(payload, "requestId", 64);
      const billboardId = requiredString(payload, "billboardId", 64);
      return requestId && billboardId
        ? { ok: true, value: { type: decoded.type, payload: { requestId, billboardId } } }
        : { ok: false, error: "Invalid billboard-interacted event" };
    }
    case "player:lost": {
      const requestId = requiredString(payload, "requestId", 64);
      if (!requestId) return { ok: false, error: "Invalid player-lost event" };
      if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.length > 64)) {
        return { ok: false, error: "Invalid loss reason" };
      }
      const lostPayload: Extract<ClientMessage, { type: "player:lost" }>["payload"] = { requestId };
      if (typeof payload.reason === "string" && payload.reason.trim()) lostPayload.reason = payload.reason.trim();
      return { ok: true, value: { type: decoded.type, payload: lostPayload } };
    }
    case "player:respawn": {
      const requestId = requiredString(payload, "requestId", 64);
      return requestId
        ? { ok: true, value: { type: decoded.type, payload: { requestId } } }
        : { ok: false, error: "Invalid player-respawn event" };
    }
    case "ping": {
      if (payload.clientTime !== undefined && !isFiniteNumber(payload.clientTime)) {
        return { ok: false, error: "Invalid client time" };
      }
      return {
        ok: true,
        value: {
          type: decoded.type,
          payload: typeof payload.clientTime === "number" ? { clientTime: payload.clientTime } : {},
        },
      };
    }
    default:
      return { ok: false, error: `Unknown message type: ${decoded.type}` };
  }
}
