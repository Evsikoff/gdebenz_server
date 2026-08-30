import { describe, expect, it } from "vitest";
import { createBot, stepBot } from "../src/bots.js";
import { CONFIG, type GameConfig } from "../src/config.js";
import { Random } from "../src/random.js";
import { buildCity, initialiseStations } from "../src/world.js";

const botConfig: GameConfig = {
  ...CONFIG,
  baseGridSize: 4,
  stationsPerBaseMap: 4,
  canistersPerBaseMap: 4,
  fuelBurnPerSecond: 0,
};

function routeFixture() {
  const city = buildCity(1, 1, botConfig);
  initialiseStations(city, botConfig);
  const rng = new Random(123);
  const bot = createBot(0, city, [], rng, botConfig);
  const station = city.stations[0]!;
  const canister = city.canisters[0]!;
  for (const value of city.stations) value.state = value === station ? "active" : "locked";
  for (const value of city.canisters) value.taken = value !== canister;
  bot.x = 100;
  bot.y = 100;
  bot.speed = 0;
  bot.aggroCd = 999;
  bot.goal = null;
  bot.think = 0;
  station.x = 420;
  station.y = 420;
  canister.x = 900;
  canister.y = 900;
  canister.cool = 0;
  return { city, rng, bot, station, canister };
}

describe("два алгоритма ботов", () => {
  it("алгоритм station подбирает канистру по пути к ближайшей АЗС", () => {
    const { city, rng, bot, station, canister } = routeFixture();
    canister.x = (bot.x + station.x + station.w / 2) / 2;
    canister.y = (bot.y + station.y + station.h / 2) / 2;
    bot.plan = "station";
    bot.gotCanister = false;

    stepBot(bot, city, 0.001, [], rng, botConfig);

    expect(bot.goal).toMatchObject({ kind: "canister", id: canister.id });
  });

  it("алгоритм canister заезжает на активную АЗС по пути к канистре", () => {
    const { city, rng, bot, station, canister } = routeFixture();
    const centerX = 500;
    const centerY = 500;
    station.x = centerX - station.w / 2;
    station.y = centerY - station.h / 2;
    canister.x = 900;
    canister.y = 900;
    bot.plan = "canister";
    bot.gotCanister = false;
    bot.refuelled = false;

    stepBot(bot, city, 0.001, [], rng, botConfig);

    expect(bot.goal).toMatchObject({ kind: "station", id: station.id });
  });

  it("во время охоты преследует ближайшего активного игрока как в офлайне", () => {
    const { city, rng, bot } = routeFixture();
    bot.aggro = 2;
    const player = { id: "player:nearest", x: 240, y: 220 };

    stepBot(bot, city, 0.001, [player, { id: "player:far", x: 2_000, y: 2_000 }], rng, botConfig);

    expect(bot.goal).toMatchObject({ kind: "player", id: player.id, x: player.x, y: player.y });
  });
});
