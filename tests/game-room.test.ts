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

const eventRoomConfig: GameConfig = {
  ...smallRoomConfig,
  botCount: 1,
  stationLimitChance: 0,
};

describe("GameRoom", () => {
  it("rebalances bots on join and leave", () => {
    const room = new GameRoom();
    expect(room.botCount).toBe(10);
    const removedBotSpawn = { x: room.bots.at(-1)!.x, y: room.bots.at(-1)!.y };
    const player = room.addPlayer("Ева");
    expect(room.botCount).toBe(9);
    room.removePlayer(player.id);
    expect(room.botCount).toBe(10);
    expect({ x: room.bots.at(-1)!.x, y: room.bots.at(-1)!.y }).not.toEqual(removedBotSpawn);
  });

  it("spawns players at different random road locations", () => {
    const room = new GameRoom({ ...smallRoomConfig, botCount: 10 });
    const players = [room.addPlayer("Первый"), room.addPlayer("Второй"), room.addPlayer("Третий")];

    expect(new Set(players.map((player) => `${player.x}:${player.y}`)).size).toBe(players.length);
    for (const player of players) {
      expect(
        room.city.roadCenters.some(
          (roadCenter) => Math.abs(player.x - roadCenter) < 0.001 || Math.abs(player.y - roadCenter) < 0.001,
        ),
      ).toBe(true);
    }
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

  it("records filled fuel once and updates the leaderboard", () => {
    const room = new GameRoom(eventRoomConfig);
    const player = room.addPlayer("Заправщик");
    const station = room.city.stations.find((value) => value.state === "active")!;
    player.x = station.x + station.w / 2;
    player.y = station.y + station.h / 2;
    player.fuel = 10;
    const moneyBefore = player.money;

    const first = room.reportFuelFilled(player.id, "fuel-1", station.id, 5);
    const duplicate = room.reportFuelFilled(player.id, "fuel-1", station.id, 5);

    expect(first).toEqual(duplicate);
    expect(first.type === "game:event-result" && first.payload).toMatchObject({
      event: "fuel-filled",
      ok: true,
      code: "accepted",
      details: { liters: 5, totalLiters: 5 },
    });
    expect(player.filledLiters).toBe(5);
    expect(player.fuel).toBe(15);
    expect(player.money).toBe(moneyBefore - 5 * station.price);
    expect(room.leaderboard()[0]).toMatchObject({ entityId: player.id, liters: 5, position: 1, active: true });
  });

  it("enforces the cumulative station limit for fuel facts", () => {
    const room = new GameRoom({ ...eventRoomConfig, stationLimitChance: 1, stationFuelLimit: 6 });
    const player = room.addPlayer("Лимит");
    const station = room.city.stations.find((value) => value.state === "active")!;
    player.x = station.x + station.w / 2;
    player.y = station.y + station.h / 2;
    player.fuel = 0;

    expect(room.reportStationBlocked(player.id, "lock-limit", station.id).payload.ok).toBe(true);
    expect(room.reportFuelFilled(player.id, "fuel-limit-1", station.id, 4).payload.ok).toBe(true);
    const rejected = room.reportFuelFilled(player.id, "fuel-limit-2", station.id, 3);

    expect(rejected.payload).toMatchObject({ ok: false, code: "station-limit-exceeded" });
    expect(player.filledLiters).toBe(4);
  });

  it("blocks a station for the offline timeout and activates a different random station", () => {
    const room = new GameRoom(eventRoomConfig);
    const player = room.addPlayer("Таймер");
    const station = room.city.stations.find((value) => value.state === "active")!;
    player.x = station.x + station.w / 2;
    player.y = station.y + station.h / 2;
    player.canisters = 2;

    const result = room.reportStationBlocked(player.id, "lock-1", station.id);
    expect(result.payload).toMatchObject({
      event: "station-blocked",
      ok: true,
      details: { canisters: 2, unlockIn: 3, chainScheduled: true },
    });
    expect(station.state).toBe("locked");

    for (let index = 0; index < 31; index += 1) room.step(0.1);
    const active = room.city.stations.filter((value) => value.state === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(station.id);
    expect(active[0]!.origin).toBe("timer");
  });

  it("activates a random station after a billboard fact", () => {
    const room = new GameRoom(eventRoomConfig);
    const player = room.addPlayer("Реклама");
    const station = room.city.stations.find((value) => value.state === "active")!;
    player.x = station.x + station.w / 2;
    player.y = station.y + station.h / 2;
    room.reportStationBlocked(player.id, "lock-ad", station.id);
    expect(room.city.stations.every((value) => value.state === "locked")).toBe(true);

    const billboard = room.city.billboards[0]!;
    player.x = billboard.x + billboard.w / 2;
    player.y = billboard.y + billboard.h / 2;
    const result = room.reportBillboardInteraction(player.id, "ad-1", billboard.id);

    expect(result.payload).toMatchObject({ event: "billboard-interacted", ok: true, code: "accepted" });
    expect(billboard.state).toBe("done");
    expect(room.city.stations.filter((value) => value.state === "active")).toHaveLength(1);
    expect(room.city.stations.find((value) => value.state === "active")!.origin).toBe("ad");
  });

  it("despawns a lost player and respawns it at a new random road location with reset resources", () => {
    const room = new GameRoom(eventRoomConfig);
    const player = room.addPlayer("Возвращение");
    const initialSpawn = { x: player.x, y: player.y, angle: player.angle };
    player.x += 1_000;
    player.y += 1_000;
    player.fuel = 7;
    player.tankVolume = 80;
    player.money = 300;
    player.canisters = 3;
    player.filledLiters = 12;

    const lost = room.reportPlayerLost(player.id, "lost-1", "out-of-fuel");
    expect(lost.payload).toMatchObject({ event: "player-lost", ok: true, details: { reason: "out-of-fuel" } });
    expect(player.status).toBe("lost");
    expect(room.entitySnapshot().players).toHaveLength(0);
    expect(room.leaderboard().find((row) => row.entityId === player.id)).toMatchObject({ liters: 12, active: false });
    expect(
      room.setInput(player.id, {
        seq: 1,
        worldRevision: room.revision,
        up: true,
        down: false,
        left: false,
        right: false,
        handbrake: false,
      }),
    ).toEqual({ ok: false, code: "player-inactive" });

    const respawn = room.respawnPlayer(player.id, "respawn-1");
    expect(respawn.payload).toMatchObject({ event: "player-respawn", ok: true, code: "accepted" });
    expect(player).toMatchObject({
      status: "active",
      speed: 0,
      fuel: eventRoomConfig.startFuel,
      tankVolume: eventRoomConfig.startTankVolume,
      money: eventRoomConfig.startMoney,
      canisters: 0,
      filledLiters: 0,
    });
    expect({ x: player.x, y: player.y, angle: player.angle }).not.toEqual(initialSpawn);
    expect(
      room.city.roadCenters.some(
        (roadCenter) => Math.abs(player.x - roadCenter) < 0.001 || Math.abs(player.y - roadCenter) < 0.001,
      ),
    ).toBe(true);
    expect(room.entitySnapshot().players).toHaveLength(1);
  });

  it("sorts all players and bots by session liters with stable ties", () => {
    const room = new GameRoom({ ...eventRoomConfig, botCount: 3 });
    const first = room.addPlayer("Первый");
    const second = room.addPlayer("Второй");
    first.filledLiters = 8;
    second.filledLiters = 12;
    room.bots[0]!.filledLiters = 8;

    const rows = room.leaderboard();
    expect(rows.map((row) => [row.name, row.liters, row.position])).toEqual([
      ["Второй", 12, 1],
      ["Первый", 8, 2],
      [room.bots[0]!.name, 8, 3],
    ]);
  });

  it("отбрасывает машины и рассылает событие при таране игрока в бота", () => {
    const room = new GameRoom({ ...smallRoomConfig, botCount: 2 });
    const player = room.addPlayer("Таран");
    const bot = room.bots[0]!;
    for (const other of room.bots.slice(1)) {
      other.x = 100;
      other.y = 100;
      other.speed = 0;
      other.wait = 999;
    }
    const messages: unknown[] = [];
    room.on("message", (message) => messages.push(message));

    // ставим бота ровно перед носом игрока и разгоняем игрока в него
    bot.x = player.x + 30;
    bot.y = player.y;
    bot.speed = 0;
    bot.wait = 0;
    bot.kx = 0;
    bot.ky = 0;
    player.angle = 0;
    player.speed = 500;

    room.step(1 / 30);

    const collision = messages.find(
      (message) => (message as { type: string }).type === "world:collisions",
    ) as { payload: { collisions: Array<{ force: number; rammerId: string; victimId: string }> } } | undefined;

    expect(collision).toBeDefined();
    expect(collision!.payload.collisions).toHaveLength(1);
    expect(collision!.payload.collisions[0]!.rammerId).toBe(player.id);
    expect(collision!.payload.collisions[0]!.victimId).toBe(bot.id);
    expect(collision!.payload.collisions[0]!.force).toBeGreaterThan(0);
    // протаранённого отбросило и оглушило, таранивший потерял скорость
    expect(Math.hypot(bot.kx, bot.ky)).toBeGreaterThan(0);
    expect(bot.stun).toBeGreaterThan(0);
    expect(player.speed).toBeLessThan(500);
    // кузова расталкиваются, а не слипаются
    expect(Math.hypot(bot.x - player.x, bot.y - player.y)).toBeGreaterThan(30);
  });

  it("выбивает канистры из протаранённого бота", () => {
    const room = new GameRoom({ ...smallRoomConfig, botCount: 2 });
    const player = room.addPlayer("Таран");
    const bot = room.bots[0]!;
    for (const other of room.bots.slice(1)) {
      other.x = 100;
      other.y = 100;
      other.speed = 0;
      other.wait = 999;
    }
    const canister = room.city.canisters[0]!;
    canister.taken = true;
    bot.taken = 1;
    bot.wait = 0;

    bot.x = player.x + 30;
    bot.y = player.y;
    bot.speed = 0;
    player.angle = 0;
    player.speed = 500;

    room.step(1 / 30);

    expect(bot.taken).toBe(0);
    expect(canister.taken).toBe(false);
    expect(canister.cool).toBeGreaterThan(0);
  });

  it("не считает тараном лёгкое касание бортами", () => {
    const room = new GameRoom({ ...smallRoomConfig, botCount: 2 });
    const player = room.addPlayer("Сосед");
    const bot = room.bots[0]!;
    for (const other of room.bots.slice(1)) {
      other.x = 100;
      other.y = 100;
      other.speed = 0;
      other.wait = 999;
    }
    const messages: unknown[] = [];
    room.on("message", (message) => messages.push(message));

    // едут рядом в одну сторону и лишь коснулись боками
    bot.x = player.x;
    bot.y = player.y + 30;
    bot.angle = 0;
    bot.speed = 200;
    bot.wait = 0;
    player.angle = 0;
    player.speed = 200;

    room.step(1 / 30);

    expect(messages.some((message) => (message as { type: string }).type === "world:collisions")).toBe(false);
    expect(bot.stun).toBe(0);
  });

  it("сталкивает игроков между собой", () => {
    const room = new GameRoom({ ...smallRoomConfig, botCount: 2 });
    const first = room.addPlayer("Первый");
    const second = room.addPlayer("Второй");
    for (const bot of room.bots) {
      bot.x = 100;
      bot.y = 100;
      bot.speed = 0;
      bot.wait = 999;
    }
    const messages: unknown[] = [];
    room.on("message", (message) => messages.push(message));

    second.x = first.x + 30;
    second.y = first.y;
    second.speed = 0;
    first.angle = 0;
    first.speed = 500;

    room.step(1 / 30);

    const collision = messages.find(
      (message) => (message as { type: string }).type === "world:collisions",
    ) as { payload: { collisions: Array<{ rammerId: string; victimId: string; victimIsPlayer: boolean }> } } | undefined;

    expect(collision).toBeDefined();
    expect(collision!.payload.collisions[0]!.rammerId).toBe(first.id);
    expect(collision!.payload.collisions[0]!.victimId).toBe(second.id);
    expect(collision!.payload.collisions[0]!.victimIsPlayer).toBe(true);
    expect(Math.hypot(second.kx, second.ky)).toBeGreaterThan(0);
  });

  it("выбивает канистры из протаранённого игрока и возвращает объём бака", () => {
    const room = new GameRoom({ ...smallRoomConfig, botCount: 2 });
    const first = room.addPlayer("Первый");
    const second = room.addPlayer("Второй");
    for (const bot of room.bots) {
      bot.x = 100;
      bot.y = 100;
      bot.speed = 0;
      bot.wait = 999;
    }
    const canister = room.city.canisters[0]!;
    canister.taken = true;
    second.canisters = 1;
    second.tankVolume = CONFIG.startTankVolume + CONFIG.canisterTankBonus;
    second.fuel = second.tankVolume;

    second.x = first.x + 30;
    second.y = first.y;
    second.speed = 0;
    first.angle = 0;
    first.speed = 500;

    room.step(1 / 30);

    expect(second.canisters).toBe(0);
    expect(second.tankVolume).toBe(CONFIG.startTankVolume);
    expect(second.fuel).toBeLessThanOrEqual(CONFIG.startTankVolume);
    expect(canister.taken).toBe(false);
  });
});
