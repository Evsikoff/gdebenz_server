import { describe, expect, it } from "vitest";
import { botCountForPlayers, CONFIG, mapScaleForPlayers } from "../src/config.js";

describe("player-count rules", () => {
  it("removes exactly one bot for every connected player", () => {
    expect(botCountForPlayers(0)).toBe(CONFIG.botCount);
    expect(botCountForPlayers(1)).toBe(CONFIG.botCount - 1);
    expect(botCountForPlayers(CONFIG.botCount)).toBe(0);
    expect(botCountForPlayers(CONFIG.botCount + 10)).toBe(0);
  });

  it("uses floor only when players / botCount is greater than two", () => {
    expect(mapScaleForPlayers(20)).toBe(1);
    expect(mapScaleForPlayers(21)).toBe(2);
    expect(mapScaleForPlayers(29)).toBe(2);
    expect(mapScaleForPlayers(30)).toBe(3);
  });
});
