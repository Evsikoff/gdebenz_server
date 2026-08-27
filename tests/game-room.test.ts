import { describe, expect, it, vi } from "vitest";
import { CONFIG, type GameConfig } from "../src/config.js";
import { GameRoom } from "../src/game-room.js";

const smallRoomConfig: GameConfig = {
  ...CONFIG,
  botCount: 2,
  baseGridSize: 4,
  stationsPerBaseMap: 4,
  canistersPerBaseMap: 4,
  billboardsPerClient: 1,
};

describe("GameRoom", () => {
  it("rebalances bots on join and leave", () => {
    const room = new GameRoom();
    expect(room.botCount).toBe(10);
    const player = room.addPlayer("Ева");
    expect(room.botCount).toBe(9);
    room.removePlayer(player.id);
    expect(room.botCount).toBe(10);
  });

  it("updates existing players, the map and fuel at the scaling threshold", () => {
    const room = new GameRoom(smallRoomConfig);
    const mapUpdates: unknown[] = [];
    room.on("message", (message) => {
      if (message.type === "world:map-update") mapUpdates.push(message);
    });

    const first = room.addPlayer("Первый");
    first.fuel = 35;
    room.addPlayer("Второй");
    room.addPlayer("Третий");
    room.addPlayer("Четвёртый");
    const newcomer = room.addPlayer("Пятый");

    expect(room.city.meta.scale).toBe(2);
    expect(first.fuel).toBe(45);
    expect(newcomer.fuel).toBe(smallRoomConfig.startFuel);
    expect(room.city.base.id).toBe("base");
    expect(mapUpdates).toHaveLength(1);

    room.removePlayer(newcomer.id);
    expect(room.city.meta.scale).toBe(1);
    expect(first.fuel).toBe(50);
    expect(mapUpdates).toHaveLength(2);
  });

  it("caps the map-change fuel bonus at tank volume", () => {
    const room = new GameRoom(smallRoomConfig);
    const first = room.addPlayer("Первый");
    first.fuel = 48;
    for (let index = 2; index <= 5; index += 1) room.addPlayer(`Игрок ${index}`);
    expect(first.fuel).toBe(50);
  });

  it("processes canister, station, billboard and base interactions", () => {
    const room = new GameRoom();
    const player = room.addPlayer("Тестер");

    const canister = room.city.canisters.find((value) => !value.taken)!;
    player.x = canister.x;
    player.y = canister.y;
    const canisterResult = room.interact(player.id, {
      requestId: "can-1",
      objectType: "canister",
      objectId: canister.id,
    });
    expect(canisterResult.type).toBe("interaction:result");
    expect(player.tankVolume).toBe(CONFIG.startTankVolume + CONFIG.canisterTankBonus);

    const station = room.city.stations.find((value) => value.state === "active")!;
    player.x = station.x + station.w / 2;
    player.y = station.y + station.h / 2;
    player.fuel = 40;
    const stationResult = room.interact(player.id, {
      requestId: "station-1",
      objectType: "station",
      objectId: station.id,
      amount: 5,
    });
    expect(stationResult.type === "interaction:result" && stationResult.payload.ok).toBe(true);
    expect(player.fuel).toBe(45);
    expect(station.state).toBe("locked");

    const billboard = room.city.billboards[0]!;
    player.x = billboard.x + billboard.w / 2;
    player.y = billboard.y + billboard.h / 2;
    const billboardResult = room.interact(player.id, {
      requestId: "ad-1",
      objectType: "billboard",
      objectId: billboard.id,
    });
    expect(billboardResult.type === "interaction:result" && billboardResult.payload.ok).toBe(true);
    expect(billboard.state).toBe("done");

    player.x = room.city.base.x + room.city.base.w / 2;
    player.y = room.city.base.y + room.city.base.h / 2;
    const moneyBefore = player.money;
    const baseResult = room.interact(player.id, {
      requestId: "base-1",
      objectType: "base",
      objectId: "base",
      amount: 10,
    });
    expect(baseResult.type === "interaction:result" && baseResult.payload.ok).toBe(true);
    expect(player.money).toBe(moneyBefore + 10 * CONFIG.fuelSellPrice);
  });

  it("broadcasts entity snapshots at the configured rate", () => {
    vi.useFakeTimers();
    const room = new GameRoom();
    room.addPlayer("Ева");
    const messages: string[] = [];
    room.on("message", (message) => messages.push(message.type));
    room.step(1 / CONFIG.snapshotRate);
    expect(messages).toContain("world:entities");
    vi.useRealTimers();
  });
});
