import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol.js";

describe("WebSocket protocol validation", () => {
  it("accepts a valid join", () => {
    expect(parseClientMessage(JSON.stringify({ type: "player:join", payload: { name: "Ева" } }))).toEqual({
      ok: true,
      value: { type: "player:join", payload: { name: "Ева" } },
    });
  });

  it("rejects malformed coordinates and unknown messages", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "player:move",
          payload: { seq: 1, worldRevision: 1, x: "NaN", y: 10, angle: 0, speed: 0 },
        }),
      ).ok,
    ).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "hack", payload: {} })).ok).toBe(false);
  });

  it.each([
    [
      { type: "player:fuel-filled", payload: { requestId: "fuel-1", stationId: "station:1", liters: 4.5 } },
      { type: "player:fuel-filled", payload: { requestId: "fuel-1", stationId: "station:1", liters: 4.5 } },
    ],
    [
      { type: "station:blocked", payload: { requestId: "lock-1", stationId: "station:1" } },
      { type: "station:blocked", payload: { requestId: "lock-1", stationId: "station:1" } },
    ],
    [
      { type: "billboard:interacted", payload: { requestId: "ad-1", billboardId: "billboard:1" } },
      { type: "billboard:interacted", payload: { requestId: "ad-1", billboardId: "billboard:1" } },
    ],
    [
      { type: "player:lost", payload: { requestId: "lost-1", reason: " out-of-fuel " } },
      { type: "player:lost", payload: { requestId: "lost-1", reason: "out-of-fuel" } },
    ],
    [
      { type: "player:respawn", payload: { requestId: "respawn-1" } },
      { type: "player:respawn", payload: { requestId: "respawn-1" } },
    ],
  ])("accepts game event %s", (message, expected) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, value: expected });
  });

  it.each([
    { type: "player:fuel-filled", payload: { requestId: "fuel-1", stationId: "station:1", liters: 0 } },
    { type: "station:blocked", payload: { requestId: "", stationId: "station:1" } },
    { type: "billboard:interacted", payload: { requestId: "ad-1", billboardId: "" } },
    { type: "player:lost", payload: { requestId: "lost-1", reason: "x".repeat(65) } },
    { type: "player:respawn", payload: {} },
  ])("rejects invalid game event %s", (message) => {
    expect(parseClientMessage(JSON.stringify(message)).ok).toBe(false);
  });
});
