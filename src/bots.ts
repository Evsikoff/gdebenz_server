import { CONFIG, type GameConfig } from "./config.js";
import { Random } from "./random.js";
import type { BotGoal, BotState, Canister, City, Station } from "./types.js";
import { getRandomSpawn, isInside, nearestRoadCenter } from "./world.js";

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

export interface BotStep {
  canister: Canister | null;
  station: Station | null;
  soldAtBase: boolean;
}

const LANE_EPS = 60;
const FINAL_DIST = 190;
const DETOUR = 260;
const SELL_SECONDS = 2;
const SELL_FROM = 2;
const THINK_SECONDS = 0.25;

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

function nearest<T extends { x: number; y: number }>(bot: BotState, values: T[]): T | null {
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

function chooseGoal(bot: BotState, city: City, rng: Random): BotGoal {
  const stations = city.stations.filter((station) => station.state === "active");
  const canisters = city.canisters.filter((canister) => !canister.taken && canister.cool <= 0);
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
  bot.speed =
    bot.speed < targetSpeed
      ? Math.min(targetSpeed, bot.speed + config.acceleration * dt)
      : Math.max(targetSpeed, bot.speed - config.brakeAcceleration * dt);
  bot.x = clamp(bot.x + Math.cos(bot.angle) * bot.speed * dt, 30, worldSize - 30);
  bot.y = clamp(bot.y + Math.sin(bot.angle) * bot.speed * dt, 30, worldSize - 30);
}

function rollPlan(bot: BotState, rng: Random): void {
  bot.plan = rng.bool() ? "station" : "canister";
  bot.gotCanister = false;
  bot.refuelled = false;
  bot.goal = null;
  bot.think = 0;
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
    filledLiters: 0,
    plan: "station",
    goal: null,
    gotCanister: false,
    refuelled: false,
    wait: 0,
    think: 0,
    taken: 0,
    style: 0.82 + rng.next() * 0.18,
    lane: (rng.bool() ? -1 : 1) * (18 + rng.next() * 26),
    wobble: rng.next() * Math.PI * 2,
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
  rng: Random,
  config: GameConfig = CONFIG,
): BotStep {
  const result: BotStep = { canister: null, station: null, soldAtBase: false };
  applyKnock(bot, city.meta.worldSize, dt);
  if (bot.stun > 0) {
    // получил в бок — пару мгновений машину просто несёт
    bot.stun = Math.max(0, bot.stun - dt);
    bot.speed *= Math.max(0, 1 - 4 * dt);
    bot.think = 0;
    return result;
  }
  if (bot.wait > 0) {
    bot.wait = Math.max(0, bot.wait - dt);
    bot.speed *= Math.max(0, 1 - 6 * dt);
    return result;
  }

  bot.think -= dt;
  if (!bot.goal || bot.think <= 0 || isGoalStale(bot.goal, city)) {
    bot.goal = chooseGoal(bot, city, rng);
    bot.think = THINK_SECONDS * (0.7 + rng.next() * 0.6);
  }

  const goal = bot.goal;
  const target = waypoint(bot, city, goal);
  drive(bot, target, city.meta.worldSize, dt, config);
  bot.wobble += dt * (0.7 + bot.style);

  const pickupRadiusSquared = (config.carRadius + config.canisterRadius) ** 2;
  for (const canister of city.canisters) {
    if (canister.taken || canister.cool > 0) continue;
    if ((bot.x - canister.x) ** 2 + (bot.y - canister.y) ** 2 > pickupRadiusSquared) continue;
    canister.taken = true;
    bot.gotCanister = true;
    bot.taken += 1;
    bot.think = 0;
    result.canister = canister;
    break;
  }

  if (goal.kind === "base" && isInside(bot, city.base)) {
    bot.wait = SELL_SECONDS;
    bot.taken = 0;
    bot.gotCanister = false;
    bot.goal = null;
    bot.think = 0;
    result.soldAtBase = true;
  } else if (goal.kind === "station") {
    const station = city.stations.find((value) => value.id === goal.id);
    if (station?.state === "active" && isInside(bot, station)) {
      bot.wait = Math.max(
        0,
        config.stationTimeoutBase + config.stationTimeoutPerCanister * Math.max(0, bot.taken),
      );
      bot.refuelled = true;
      bot.goal = null;
      bot.think = 0;
      result.station = station;
    }
  } else if (goal.kind === "wander" && Math.hypot(goal.x - bot.x, goal.y - bot.y) < 60) {
    bot.goal = null;
    bot.think = 0;
  }

  if (bot.refuelled && (bot.plan === "station" || bot.gotCanister)) rollPlan(bot, rng);
  return result;
}
