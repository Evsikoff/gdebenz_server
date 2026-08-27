import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { buildCity } from "../src/world.js";

describe("world generation", () => {
  it("keeps the client-compatible base dimensions and object counts", () => {
    const city = buildCity(1);
    expect(city.meta.grid).toBe(CONFIG.baseGridSize);
    expect(city.meta.worldSize).toBe(
      CONFIG.baseGridSize * CONFIG.blockSize + (CONFIG.baseGridSize + 1) * CONFIG.roadWidth,
    );
    expect(city.stations).toHaveLength(CONFIG.stationsPerBaseMap);
    expect(city.canisters).toHaveLength(CONFIG.canistersPerBaseMap);
    expect(city.billboards).toHaveLength(CONFIG.billboardsPerClient * 9);
    expect(city.base.id).toBe("base");
  });

  it("scales both sides and object counts with area while keeping one base", () => {
    const city = buildCity(2);
    expect(city.meta.grid).toBe(CONFIG.baseGridSize * 2);
    expect(city.stations).toHaveLength(CONFIG.stationsPerBaseMap * 4);
    expect(city.canisters).toHaveLength(CONFIG.canistersPerBaseMap * 4);
    expect(city.billboards).toHaveLength(CONFIG.billboardsPerClient * 9 * 4);
    expect(city.base).toBeDefined();
  });

  it("is deterministic for the same scale and seed", () => {
    const first = buildCity(1);
    const second = buildCity(1);
    expect(second.stations).toEqual(first.stations);
    expect(second.billboards).toEqual(first.billboards);
    expect(second.canisters).toEqual(first.canisters);
    expect(second.base).toEqual(first.base);
  });
});
