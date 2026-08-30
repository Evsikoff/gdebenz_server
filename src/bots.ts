import { CONFIG, type GameConfig } from "./config.js";
import { Random } from "./random.js";
import type { BotGoal, BotState, Canister, City, Station } from "./types.js";
import { getRandomSpawn, nearestRoadCenter } from "./world.js";

/*
 * Серверный порт двух офлайн-алгоритмов citi_ads/src/game/bots.ts:
 * 1) ближайшая АЗС с подбором канистры по пути;
 * 2) ближайшая канистра с заездом на АЗС по пути.
 * Манера езды, случайные паузы и охота за игроком повторяют офлайн-режим.
 */

export const BOT_COLORS = [
  "#3f8cff",
  "#f2a93b",
  "#8b5cf6",
  "#22c3a6",
  "#ff7ab8",
  "#c9d64b",
  "#ff8b3d",
  "#4dd2ff",
  "#b07d4f",
  "#9aa7bd",
] as const;

export const BOT_NAMES = [
  "__Вихрь",
  "__Полночь",
  "__Форсаж",
  "__Клаксон",
  "__Дизель",
  "__Гроза",
  "__Фара",
  "__Турбина",
  "__Шумахер",
  "__Ночник",
] as const;

export interface BotTarget {
  id: string;
  x: number;
  y: number;
}

export interface BotStep {
  canister: Canister | null;
  station: Station | null;
  soldAtBase: boolean;
  filledLiters: number;
  lost: boolean;
}

const LANE_EPS = 60;
const FINAL_DIST = 190;
const DETOUR = 260;
const SELL_SECONDS = 2;
const SELL_FROM = 2;
const THINK_SECONDS = 0.25;
const AGGRO_RANGE = 1_300;
const AGGRO_CHANCE = 0.14;
const AGGRO_PAUSE = 14;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function grip(speed: number, config: GameConfig): number {
  const absolute = Math.abs(speed);
  return Math.min(absolute / 150, 1) * (1 - 0.42 * (absolute / config.maxSpeed));
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function nearest<T extends { x: number; y: number }>(bot: BotState, values: readonly T[]): T | null {
  let result: T | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const distance = Math.hypot(value.x - bot.x, value.y - bot.y);
    if (distance < best) {
      best = distance;
      result = value;
    }
  }
  return result;
}

function stationGoal(station: Station): BotGoal {
  return { kind: "station", id: station.id, x: station.x + station.w / 2, y: station.y + station.h / 2 };
}

function canisterGoal(canister: Canister): BotGoal {
  return { kind: "canister", id: canister.id, x: canister.x, y: canister.y };
}

function activeStations(city: City): Station[] {
  return city.stations.filter((station) => station.state === "active");
}

function freeCanisters(city: City): Canister[] {
  return city.canisters.filter((canister) => !canister.taken);
}

function chooseGoal(bot: BotState, city: City, rng: Random): BotGoal {
  const stations = activeStations(city);
  const canisters = freeCanisters(city);

  if (bot.taken >= SELL_FROM) {
    return { kind: "base", x: city.base.x + city.base.w / 2, y: city.base.y + city.base.h / 2 };
  }

  if (bot.plan === "station" || bot.gotCanister) {
    const targetStation = nearest(
      bot,
      stations.map((station) => ({ x: station.x + station.w / 2, y: station.y + station.h / 2, station })),
    );
    if (!targetStation) {
      const targetCanister = nearest(bot, canisters);
      return targetCanister ? canisterGoal(targetCanister) : wanderGoal(city, rng);
    }
    if (bot.plan === "station") {
      const onWay = canisters
        .filter(
          (canister) =>
            distanceToSegment(canister.x, canister.y, bot.x, bot.y, targetStation.x, targetStation.y) < DETOUR,
        )
        .sort(
          (left, right) =>
            Math.hypot(left.x - bot.x, left.y - bot.y) - Math.hypot(right.x - bot.x, right.y - bot.y),
        )[0];
      if (onWay) return canisterGoal(onWay);
    }
    return stationGoal(targetStation.station);
  }

  const targetCanister = nearest(bot, canisters);
  if (!targetCanister) {
    const targetStation = nearest(
      bot,
      stations.map((station) => ({ x: station.x + station.w / 2, y: station.y + station.h / 2, station })),
    );
    return targetStation ? stationGoal(targetStation.station) : wanderGoal(city, rng);
  }
  if (!bot.refuelled) {
    const onWay = stations
      .map((station) => ({ x: station.x + station.w / 2, y: station.y + station.h / 2, station }))
      .filter(
        (station) =>
          distanceToSegment(station.x, station.y, bot.x, bot.y, targetCanister.x, targetCanister.y) < DETOUR,
      )
      .sort(
        (left, right) =>
          Math.hypot(left.x - bot.x, left.y - bot.y) - Math.hypot(right.x - bot.x, right.y - bot.y),
      )[0];
    if (onWay) return stationGoal(onWay.station);
  }
  return canisterGoal(targetCanister);
}

function wanderGoal(city: City, rng: Random): BotGoal {
  return { kind: "wander", x: rng.pick(city.roadCenters), y: rng.pick(city.roadCenters) };
}

function isGoalStale(goal: BotGoal, city: City): boolean {
  if (goal.kind === "canister") return city.canisters.find((value) => value.id === goal.id)?.taken !== false;
  if (goal.kind === "station") return city.stations.find((value) => value.id === goal.id)?.state !== "active";
  return false;
}

function waypoint(bot: BotState, city: City, goal: BotGoal): { x: number; y: number } {
  if (Math.hypot(goal.x - bot.x, goal.y - bot.y) < FINAL_DIST) return { x: goal.x, y: goal.y };
  const goalX = nearestRoadCenter(city, goal.x);
  const goalY = nearestRoadCenter(city, goal.y);
  if (Math.abs(bot.x - goalX) < LANE_EPS) return { x: goalX, y: goal.y };
  if (Math.abs(bot.y - goalY) < LANE_EPS) return { x: goal.x, y: goalY };

  const botX = nearestRoadCenter(city, bot.x);
  const botY = nearestRoadCenter(city, bot.y);
  const onColumn = Math.abs(bot.x - botX) < LANE_EPS;
  const onRow = Math.abs(bot.y - botY) < LANE_EPS;
  if (onColumn && onRow) {
    return Math.abs(goal.x - bot.x) > Math.abs(goal.y - bot.y) ? { x: goalX, y: botY } : { x: botX, y: goalY };
  }
  if (onRow) return { x: goalX, y: botY };
  if (onColumn) return { x: botX, y: goalY };
  return Math.abs(bot.x - botX) < Math.abs(bot.y - botY) ? { x: botX, y: bot.y } : { x: bot.x, y: botY };
}

/** Отлёт после тарана: гасим импульс и двигаем машину независимо от руля. */
export function applyKnock(bot: BotState, worldSize: number, dt: number): void {
  if (bot.kx === 0 && bot.ky === 0) return;
  bot.x = clamp(bot.x + bot.kx * dt, 30, worldSize - 30);
  bot.y = clamp(bot.y + bot.ky * dt, 30, worldSize - 30);
  const decay = Math.exp(-3.4 * dt);
  bot.kx *= decay;
  bot.ky *= decay;
  if (Math.hypot(bot.kx, bot.ky) < 4) {
    bot.kx = 0;
    bot.ky = 0;
  }
}

function drive(
  bot: BotState,
  target: { x: number; y: number },
  worldSize: number,
  dt: number,
  config: GameConfig,
): void {
  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const distance = Math.hypot(dx, dy) || 1;
  const perpendicularX = -dy / distance;
  const perpendicularY = dx / distance;
  const offset = bot.lane + Math.sin(bot.wobble) * 7;
  const desiredAngle = Math.atan2(
    target.y + perpendicularY * offset - bot.y,
    target.x + perpendicularX * offset - bot.x,
  );

  let angleDelta = desiredAngle - bot.angle;
  while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
  while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
  const maxTurn = 3.1 * Math.max(grip(bot.speed, config), 0.32);
  bot.angle += Math.sign(angleDelta) * Math.min(Math.abs(angleDelta), maxTurn * dt);

  let targetSpeed = config.maxSpeed * bot.style;
  targetSpeed = Math.min(targetSpeed, distance * 2.4 + 120);
  if (Math.abs(angleDelta) > 0.8) targetSpeed = Math.min(targetSpeed, config.maxSpeed * 0.26);
  else if (Math.abs(angleDelta) > 0.35) targetSpeed = Math.min(targetSpeed, config.maxSpeed * 0.55);
  if (bot.lazy > 0) targetSpeed *= 0.55;
  bot.speed =
    bot.speed < targetSpeed
      ? Math.min(targetSpeed, bot.speed + config.acceleration * dt)
      : Math.max(targetSpeed, bot.speed - config.brakeAcceleration * dt);
  bot.x = clamp(bot.x + Math.cos(bot.angle) * bot.speed * dt, 30, worldSize - 30);
  bot.y = clamp(bot.y + Math.sin(bot.angle) * bot.speed * dt, 30, worldSize - 30);
}

function updateMood(bot: BotState, dt: number, players: readonly BotTarget[], rng: Random): BotTarget | null {
  bot.wobble += dt * (0.7 + bot.style);
  if (bot.lazy > 0) bot.lazy -= dt;
  else {
    bot.lazyCd -= dt;
    if (bot.lazyCd <= 0) {
      bot.lazy = rng.bool(0.45) ? 0.35 + rng.next() * 1.1 : 0;
      bot.lazyCd = 2.5 + rng.next() * 4.5;
    }
  }

  const player = nearest(bot, players);
  if (bot.aggro > 0) {
    bot.aggro -= dt;
    if (!player || bot.aggro <= 0) {
      bot.aggro = 0;
      bot.aggroCd = AGGRO_PAUSE + rng.next() * 12;
      return null;
    }
    return player;
  }

  bot.aggroCd -= dt;
  if (!player || bot.aggroCd > 0) return null;
  const distance = Math.hypot(player.x - bot.x, player.y - bot.y);
  if (distance < AGGRO_RANGE && rng.next() < AGGRO_CHANCE * dt) {
    bot.aggro = 3.5 + rng.next() * 3.5;
    bot.goal = null;
    bot.think = 0;
    return player;
  }
  return null;
}

function rollPlan(bot: BotState, rng: Random): void {
  bot.plan = rng.bool() ? "station" : "canister";
  bot.gotCanister = false;
  bot.refuelled = false;
  bot.goal = null;
  bot.think = 0;
}

function burnFuel(bot: BotState, dt: number, accelerating: boolean, config: GameConfig): boolean {
  const speedRatio = Math.abs(bot.speed) / config.maxSpeed;
  const burn = config.fuelBurnPerSecond * (0.09 + (accelerating ? 0.42 + speedRatio * 0.49 : 0));
  bot.fuel = Math.max(0, bot.fuel - burn * dt);
  if (bot.fuel > 0) return false;
  bot.status = "lost";
  bot.speed = 0;
  bot.wait = 0;
  bot.refuelStationId = null;
  bot.refuelDuration = 0;
  bot.refuelRemaining = 0;
  bot.refuelTargetLiters = 0;
  bot.refuelLiters = 0;
  bot.refuelSpent = 0;
  bot.respawnRemaining = config.botRespawnDelay;
  bot.goal = null;
  return true;
}

function updateWait(bot: BotState, city: City, dt: number, config: GameConfig): number {
  let filled = 0;
  if (bot.refuelStationId) {
    const station = city.stations.find((value) => value.id === bot.refuelStationId);
    const elapsed = Math.min(dt, bot.refuelRemaining);
    const nextRemaining = Math.max(0, bot.refuelRemaining - elapsed);
    const nextElapsed = bot.refuelDuration - nextRemaining;
    const desired =
      bot.refuelDuration <= 0
        ? bot.refuelTargetLiters
        : bot.refuelTargetLiters * (nextElapsed / bot.refuelDuration);
    const amount = Math.max(0, Math.min(bot.refuelTargetLiters - bot.refuelLiters, desired - bot.refuelLiters));
    if (station) {
      const before = bot.fuel;
      bot.fuel = Math.min(bot.tankVolume, bot.fuel + amount);
      filled = bot.fuel - before;
      const paid = filled * station.price;
      bot.money = Math.max(0, bot.money - paid);
      bot.filledLiters += filled;
      bot.refuelLiters += filled;
      bot.refuelSpent += paid;
    }
    bot.refuelRemaining = nextRemaining;
  }

  bot.wait = Math.max(0, bot.wait - dt);
  bot.speed *= Math.max(0, 1 - 6 * dt);
  if (bot.wait <= 0) {
    bot.refuelStationId = null;
    bot.refuelDuration = 0;
    bot.refuelRemaining = 0;
    bot.refuelTargetLiters = 0;
    bot.refuelLiters = 0;
    bot.refuelSpent = 0;
  } else if (!bot.refuelStationId) {
    burnFuel(bot, dt, false, config);
  }
  return filled;
}

function startRefuelling(bot: BotState, station: Station, config: GameConfig): number {
  const room = Math.max(0, bot.tankVolume - bot.fuel);
  const allowance = station.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, station.limit);
  const affordable = station.price > 0 ? bot.money / station.price : Number.POSITIVE_INFINITY;
  const targetLiters = Math.max(0, Math.min(room, allowance, affordable));
  bot.refuelled = true;
  bot.goal = null;
  bot.think = 0;
  if (targetLiters <= 0.0005) return 0;

  const duration = Math.max(
    0,
    config.stationTimeoutBase + config.stationTimeoutPerCanister * Math.max(0, bot.taken),
  );
  bot.wait = duration;
  bot.refuelStationId = station.id;
  bot.refuelDuration = duration;
  bot.refuelRemaining = duration;
  bot.refuelTargetLiters = targetLiters;
  bot.refuelLiters = 0;
  bot.refuelSpent = 0;
  if (duration > 0) return 0;

  const before = bot.fuel;
  bot.fuel = Math.min(bot.tankVolume, bot.fuel + targetLiters);
  const filled = bot.fuel - before;
  const paid = filled * station.price;
  bot.money = Math.max(0, bot.money - paid);
  bot.filledLiters += filled;
  bot.refuelLiters = filled;
  bot.refuelSpent = paid;
  bot.refuelStationId = null;
  bot.refuelTargetLiters = 0;
  return filled;
}

export function createBot(
  index: number,
  city: City,
  occupied: readonly { x: number; y: number }[],
  rng: Random,
  config: GameConfig = CONFIG,
): BotState {
  const spawn = getRandomSpawn(city, rng, occupied);
  const bot: BotState = {
    id: `bot:${index}`,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    speed: 0,
    color: BOT_COLORS[index % BOT_COLORS.length]!,
    name: BOT_NAMES[index % BOT_NAMES.length]!,
    fuel: Math.min(config.startFuel, config.startTankVolume),
    tankVolume: config.startTankVolume,
    money: config.startMoney,
    status: "active",
    filledLiters: 0,
    plan: "station",
    goal: null,
    gotCanister: false,
    refuelled: false,
    wait: 0,
    refuelStationId: null,
    refuelDuration: 0,
    refuelRemaining: 0,
    refuelTargetLiters: 0,
    refuelLiters: 0,
    refuelSpent: 0,
    respawnRemaining: 0,
    think: 0,
    taken: 0,
    style: 0.82 + rng.next() * 0.18,
    lane: (rng.bool() ? -1 : 1) * (18 + rng.next() * 26),
    wobble: rng.next() * Math.PI * 2,
    lazy: 0,
    lazyCd: rng.next() * 4,
    aggro: 0,
    aggroCd: 4 + rng.next() * 14,
    kx: 0,
    ky: 0,
    stun: 0,
  };
  rollPlan(bot, rng);
  return bot;
}

export function stepBot(
  bot: BotState,
  city: City,
  dt: number,
  players: readonly BotTarget[],
  rng: Random,
  config: GameConfig = CONFIG,
): BotStep {
  const result: BotStep = { canister: null, station: null, soldAtBase: false, filledLiters: 0, lost: false };
  if (bot.status !== "active") return result;

  applyKnock(bot, city.meta.worldSize, dt);
  if (bot.stun > 0) {
    bot.stun = Math.max(0, bot.stun - dt);
    bot.speed *= Math.max(0, 1 - 4 * dt);
    bot.think = 0;
    result.lost = burnFuel(bot, dt, false, config);
    return result;
  }
  if (bot.wait > 0) {
    result.filledLiters = updateWait(bot, city, dt, config);
    result.lost = bot.fuel <= 0;
    return result;
  }

  const targetPlayer = updateMood(bot, dt, players, rng);
  if (bot.aggro > 0 && targetPlayer) {
    bot.goal = { kind: "player", id: targetPlayer.id, x: targetPlayer.x, y: targetPlayer.y };
  } else {
    bot.think -= dt;
    if (!bot.goal || bot.goal.kind === "player" || bot.think <= 0 || isGoalStale(bot.goal, city)) {
      bot.goal = chooseGoal(bot, city, rng);
      bot.think = THINK_SECONDS * (0.7 + rng.next() * 0.6);
    }
  }

  const goal = bot.goal;
  const target = waypoint(bot, city, goal);
  drive(bot, target, city.meta.worldSize, dt, config);
  if (burnFuel(bot, dt, bot.lazy <= 0, config)) {
    result.lost = true;
    return result;
  }

  const pickupRadiusSquared = (config.carRadius + config.canisterRadius) ** 2;
  for (const canister of city.canisters) {
    if (canister.taken || canister.cool > 0) continue;
    if ((bot.x - canister.x) ** 2 + (bot.y - canister.y) ** 2 > pickupRadiusSquared) continue;
    canister.taken = true;
    bot.gotCanister = true;
    bot.taken += 1;
    bot.tankVolume += config.canisterTankBonus;
    bot.think = 0;
    result.canister = canister;
  }

  if (goal.kind === "base") {
    const base = city.base;
    const inside =
      bot.x > base.x - 6 && bot.x < base.x + base.w + 6 && bot.y > base.y - 6 && bot.y < base.y + base.h + 6;
    if (inside) {
      const sold = bot.fuel / 2;
      bot.fuel -= sold;
      bot.money += Math.round(sold * config.fuelSellPrice);
      bot.wait = SELL_SECONDS;
      bot.taken = 0;
      bot.tankVolume = config.startTankVolume;
      bot.fuel = Math.min(bot.fuel, bot.tankVolume);
      bot.gotCanister = false;
      bot.goal = null;
      bot.think = 0;
      result.soldAtBase = true;
    }
  } else if (goal.kind === "station") {
    const station = city.stations.find((value) => value.id === goal.id);
    const inside =
      station &&
      bot.x > station.x - 6 &&
      bot.x < station.x + station.w + 6 &&
      bot.y > station.y - 6 &&
      bot.y < station.y + station.h + 6;
    if (station?.state === "active" && inside) {
      result.filledLiters += startRefuelling(bot, station, config);
      if (bot.refuelTargetLiters > 0 || result.filledLiters > 0) result.station = station;
    }
  } else if (goal.kind === "wander" && Math.hypot(goal.x - bot.x, goal.y - bot.y) < 60) {
    bot.goal = null;
    bot.think = 0;
  }

  if (bot.refuelled && (bot.plan === "station" || bot.gotCanister)) rollPlan(bot, rng);
  return result;
}
