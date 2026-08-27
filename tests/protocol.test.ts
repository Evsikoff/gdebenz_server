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
});
