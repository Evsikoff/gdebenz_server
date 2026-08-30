import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { botCountForPlayers, CONFIG, mapScaleForPlayers, type GameConfig } from "./config.js";
import { applyKnock, createBot, stepBot } from "./bots.js";
import type { ObjectType, ServerMessage } from "./protocol.js";
import { Random } from "./random.js";
import type {
  BotState,
  BoosterEffect,
  City,
  CollisionEvent,
  RefuelEvent,
  EntitySnapshot,
  LeaderboardEntry,
  PlayerInput,
  PlayerState,
  PublicPlayerState,
  Rect,
  Station,
} from "./types.js";
import { buildCity, getRandomSpawn, initialiseStations, isInside } from "./world.js";

const PLAYER_COLORS = [
  "#e5472f",
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#fb7185",
  "#fbbf24",
  "#2dd4bf",
  "#c084fc",
] as const;

/**
 * Физика столкновений машин — те же цифры, что в офлайн-движке клиента
 * (citi_ads/src/game/engine.ts), чтобы онлайн ощущался так же.
 */
const COLLIDE_RADIUS = 19; // радиус кузова для столкновений машин
const KICK = 1.25; // во столько раз скорость тарана превращается в отлёт
const RAM_MIN = 70; // ниже этой скорости сближения это не таран, а тычок в пробке
const KICK_MIN = 110; // слабый тычок всё равно должен быть заметен
const KICK_MAX = 620;
const STUN_SECONDS = 0.5; // сколько протараненный бот не слушается руля
const CANISTER_COOL = 1.3; // столько выпавшую канистру нельзя подобрать
const SPILL_RADIUS = 90; // радиус разлёта канистр от места удара

/** Общий вид на игрока и бота, чтобы считать столкновения одним циклом. */
interface CollisionBody {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Машина под колонкой — стенка: её не отбросить и канистры из неё не выбить. */
  fixed: boolean;
  player: PlayerState | null;
  bot: BotState | null;
}

interface UnlockTask {
  seconds: number;
  fromStationId: string;
}

interface RefuelPlan {
  stationId: string;
  targetLiters: number;
  duration: number;
  elapsed: number;
  reason: Exclude<RefuelEvent["reason"], "left" | null>;
}

interface StationLockResult {
  locked: boolean;
  unlockIn: number | null;
}

interface EventOutcome {
  ok: boolean;
  code: string;
  details?: Record<string, unknown>;
}

type GameEventName = Extract<ServerMessage, { type: "game:event-result" }>["payload"]["event"];
type GameEventResult = Extract<ServerMessage, { type: "game:event-result" }>;

export interface InteractionRequest {
  requestId: string;
  objectType: ObjectType;
  objectId: string;
  amount?: number;
}

export interface MovementResult {
  ok: boolean;
  code: string;
}

export class RoomError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GameRoom extends EventEmitter {
  readonly players = new Map<string, PlayerState>();
  bots: BotState[] = [];
  city: City;

  private readonly config: GameConfig;
  private readonly rng: Random;
  private tickNumber = 0;
  private worldRevision = 1;
  private snapshotAccumulator = 0;
  private unlockQueue: UnlockTask[] = [];
  private objectsDirty = false;
  private readonly eventResults = new Map<string, Map<string, GameEventResult>>();
  private readonly refuelSessions = new Map<string, { stationId: string; liters: number }>();
  private readonly refuelPlans = new Map<string, RefuelPlan>();
  private collisionEvents: CollisionEvent[] = [];

  constructor(config: GameConfig = CONFIG) {
    super();
    this.config = config;
    this.rng = new Random(config.worldSeed ^ 0x51f15e);
    this.city = buildCity(1, this.worldRevision, config);
    initialiseStations(this.city, config);
    this.reconcileBots();
  }

  get playerCount(): number {
    return this.players.size;
  }

  get botCount(): number {
    return this.bots.length;
  }

  get revision(): number {
    return this.worldRevision;
  }

  addPlayer(rawName: string): PlayerState {
    if (this.players.size >= this.config.maxPlayers) throw new RoomError("room-full", "The room is full");
    const existingPlayerIds = [...this.players.keys()];
    const spawn = this.randomSpawn();
    const id = randomUUID();
    const player: PlayerState = {
      id,
      name: this.uniqueName(rawName.trim()),
      x: spawn.x,
      y: spawn.y,
      angle: spawn.angle,
      speed: 0,
      color: PLAYER_COLORS[this.players.size % PLAYER_COLORS.length]!,
      fuel: Math.min(this.config.startFuel, this.config.startTankVolume),
      tankVolume: this.config.startTankVolume,
      money: this.config.startMoney,
      canisters: 0,
      filledLiters: 0,
      status: "active",
      input: emptyInput(),
      lastInputSeq: -1,
      lastMoveAt: Date.now(),
      kx: 0,
      ky: 0,
      refueling: false,
      refuelStationId: null,
      refuelLiters: 0,
      refuelSpent: 0,
      usedStationId: null,
      speedMultiplier: 1,
      fuelConsumptionMultiplier: 1,
    };
    this.players.set(id, player);

    const mapChanged = this.rebalanceForPlayerCount(existingPlayerIds);
    if (mapChanged) {
      const newSpawn = this.randomSpawn(player.id);
      player.x = newSpawn.x;
      player.y = newSpawn.y;
      player.angle = newSpawn.angle;
    }

    this.emitMessage({
      type: "player:joined",
      payload: { player: publicPlayer(player), botCount: this.bots.length },
    });
    this.emitLeaderboard();
    return player;
  }

  removePlayer(playerId: string): boolean {
    if (!this.players.delete(playerId)) return false;
    this.eventResults.delete(playerId);
    this.refuelSessions.delete(playerId);
    this.refuelPlans.delete(playerId);
    this.rebalanceForPlayerCount([...this.players.keys()]);
    this.emitMessage({ type: "player:left", payload: { playerId, botCount: this.bots.length } });
    this.emitLeaderboard();
    return true;
  }

  setInput(
    playerId: string,
    payload: PlayerInput & { seq: number; worldRevision: number },
  ): MovementResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, code: "player-not-found" };
    if (player.status !== "active") return { ok: false, code: "player-inactive" };
    const validation = this.validateMovementHeader(player, payload.seq, payload.worldRevision);
    if (!validation.ok) return validation;
    player.lastInputSeq = payload.seq;
    player.input = {
      up: payload.up,
      down: payload.down,
      left: payload.left,
      right: payload.right,
      handbrake: payload.handbrake,
    };
    return { ok: true, code: "accepted" };
  }

  /**
   * Режим совместимости для клиента с локальной физикой. Сервер ограничивает
   * скорость изменения координат и всё равно применяет границы/коллизии.
   */
  applyClientMove(
    playerId: string,
    payload: { seq: number; worldRevision: number; x: number; y: number; angle: number; speed: number },
  ): MovementResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, code: "player-not-found" };
    if (player.status !== "active") return { ok: false, code: "player-inactive" };
    const validation = this.validateMovementHeader(player, payload.seq, payload.worldRevision);
    if (!validation.ok) return validation;

    const now = Date.now();
    const elapsed = Math.max(0.05, Math.min(1, (now - player.lastMoveAt) / 1_000));
    const maximumDistance = this.config.maxSpeed * elapsed * 1.35 + 80;
    if (Math.hypot(payload.x - player.x, payload.y - player.y) > maximumDistance) {
      return { ok: false, code: "movement-too-fast" };
    }

    player.lastInputSeq = payload.seq;
    player.lastMoveAt = now;
    player.x = clamp(payload.x, this.config.carRadius + 20, this.city.meta.worldSize - this.config.carRadius - 20);
    player.y = clamp(payload.y, this.config.carRadius + 20, this.city.meta.worldSize - this.config.carRadius - 20);
    player.angle = normalizeAngle(payload.angle);
    player.speed = clamp(payload.speed, -this.config.reverseMaxSpeed, this.config.maxSpeed);
    player.input = emptyInput();
    this.resolvePlayerCollisions(player);
    this.pickNearbyCanister(player);
    return { ok: true, code: "accepted" };
  }

  interact(playerId: string, request: InteractionRequest): ServerMessage {
    const player = this.players.get(playerId);
    if (!player) {
      throw new RoomError("player-not-found", "Player is not in the room");
    }
    const failure = (code: string): ServerMessage => ({
      type: "interaction:result",
      payload: { requestId: request.requestId, ok: false, code, player: publicPlayer(player) },
    });
    if (player.status !== "active") return failure("player-inactive");

    let code = "accepted";
    let details: Record<string, unknown> = {};
    switch (request.objectType) {
      case "canister": {
        const canister = this.city.canisters.find((value) => value.id === request.objectId);
        if (!canister) return failure("object-not-found");
        if (canister.taken) return failure("canister-taken");
        if (Math.hypot(canister.x - player.x, canister.y - player.y) > this.config.carRadius + this.config.canisterRadius + 25) {
          return failure("too-far");
        }
        this.takeCanister(player, canister.id);
        details = { tankAdded: this.config.canisterTankBonus };
        break;
      }
      case "billboard": {
        const outcome = this.activateBillboard(player, request.objectId);
        if (!outcome.ok) return failure(outcome.code);
        details = outcome.details ?? {};
        break;
      }
      case "station": {
        const station = this.city.stations.find((value) => value.id === request.objectId);
        if (!station) return failure("object-not-found");
        if (!nearRect(player, station, this.config.carRadius + 25)) return failure("too-far");
        // Закрытая АЗС — это запрос бустера «Активировать эту АЗС»: открываем
        // именно её, а не случайную, как делает просмотр билборда.
        if (station.state === "locked") {
          if (!this.activateStation(station, "ad")) return failure("station-locked");
          details = {
            activated: true,
            stationId: station.id,
            price: station.price,
            limit: station.limit,
            stationsActive: this.city.stations.filter((value) => value.state === "active").length,
            stationsTotal: this.city.stations.length,
          };
          break;
        }
        // Старый клиент присылал один запрос и получал весь объём мгновенно.
        // Теперь запрос лишь подтверждает постановку в очередь: саму заправку
        // следующий тик запускает через общий таймер updateRefuelling().
        if (station.state !== "active") return failure("station-locked");
        const room = Math.max(0, player.tankVolume - player.fuel);
        const allowance = station.limit ?? Number.POSITIVE_INFINITY;
        const affordable = station.price > 0 ? player.money / station.price : Number.POSITIVE_INFINITY;
        const liters = Math.max(0, Math.min(request.amount ?? room, room, allowance, affordable));
        if (liters <= 0.0005) return failure(room <= 0.0005 ? "tank-full" : "not-enough-money");
        details = {
          scheduled: true,
          price: station.price,
          serviceTime: this.refuelDuration(player.canisters),
        };
        break;
      }
      case "base": {
        if (request.objectId !== this.city.base.id) return failure("object-not-found");
        if (!nearRect(player, this.city.base, this.config.carRadius + 25)) return failure("too-far");
        const maximum = player.fuel / 2;
        const liters = Math.max(0, Math.min(request.amount ?? maximum, maximum));
        if (liters <= 0.0005) return failure("nothing-to-sell");
        const paid = Math.round(liters * this.config.fuelSellPrice);
        player.fuel -= liters;
        player.money += paid;
        details = { liters, paid, price: this.config.fuelSellPrice };
        break;
      }
      default:
        code = "unsupported-object";
    }

    const payload: Extract<ServerMessage, { type: "interaction:result" }>["payload"] = {
      requestId: request.requestId,
      ok: code === "accepted",
      code,
      player: publicPlayer(player),
    };
    if (Object.keys(details).length > 0) payload.details = details;
    return { type: "interaction:result", payload };
  }

  reportFuelFilled(playerId: string, requestId: string, stationId: string, liters: number): GameEventResult {
    return this.processGameEvent(playerId, requestId, "fuel-filled", (player) => {
      if (player.status !== "active") return { ok: false, code: "player-inactive" };
      const station = this.city.stations.find((value) => value.id === stationId);
      if (!station) return { ok: false, code: "object-not-found" };
      if (!nearRect(player, station, this.config.carRadius + 40)) return { ok: false, code: "too-far" };
      if (!Number.isFinite(liters) || liters <= 0 || liters > player.tankVolume) {
        return { ok: false, code: "invalid-liters" };
      }
      const currentSession = this.refuelSessions.get(playerId);
      const sessionLiters = currentSession?.stationId === stationId ? currentSession.liters : 0;
      const room = Math.max(0, player.tankVolume - player.fuel);
      const allowance = station.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, station.limit - sessionLiters);
      const affordable = station.price > 0 ? player.money / station.price : Number.POSITIVE_INFINITY;
      if (liters > room + 0.0005) return { ok: false, code: "tank-capacity-exceeded" };
      if (liters > allowance + 0.0005) {
        return { ok: false, code: "station-limit-exceeded" };
      }
      if (liters > affordable + 0.0005) return { ok: false, code: "not-enough-money" };
      player.filledLiters += liters;
      player.fuel += liters;
      const spent = liters * station.price;
      player.money = Math.max(0, player.money - spent);
      this.refuelSessions.set(playerId, { stationId, liters: sessionLiters + liters });
      this.emitLeaderboard();
      return {
        ok: true,
        code: "accepted",
        details: { stationId, liters, spent, price: station.price, totalLiters: player.filledLiters, fuel: player.fuel },
      };
    });
  }

  reportStationBlocked(playerId: string, requestId: string, stationId: string): GameEventResult {
    return this.processGameEvent(playerId, requestId, "station-blocked", (player) => {
      if (player.status !== "active") return { ok: false, code: "player-inactive" };
      const station = this.city.stations.find((value) => value.id === stationId);
      if (!station) return { ok: false, code: "object-not-found" };
      if (!nearRect(player, station, this.config.carRadius + 40)) return { ok: false, code: "too-far" };
      if (station.state !== "active") return { ok: false, code: "station-locked" };
      const result = this.takeStation(station, player.canisters);
      if (result.locked) this.refuelSessions.set(playerId, { stationId, liters: 0 });
      return {
        ok: result.locked,
        code: result.locked ? "accepted" : "station-locked",
        details: {
          stationId,
          canisters: player.canisters,
          unlockIn: result.unlockIn,
          chainScheduled: result.unlockIn !== null,
        },
      };
    });
  }

  reportBillboardInteraction(playerId: string, requestId: string, billboardId: string): GameEventResult {
    return this.processGameEvent(playerId, requestId, "billboard-interacted", (player) => {
      if (player.status !== "active") return { ok: false, code: "player-inactive" };
      return this.activateBillboard(player, billboardId);
    });
  }

  reportPlayerLost(playerId: string, requestId: string, reason = "game-over"): GameEventResult {
    return this.processGameEvent(playerId, requestId, "player-lost", (player) => {
      if (player.status === "lost") return { ok: false, code: "already-lost" };
      player.status = "lost";
      player.speed = 0;
      player.input = emptyInput();
      this.refuelSessions.delete(player.id);
      this.refuelPlans.delete(player.id);
      this.emitMessage({ type: "player:despawned", payload: { playerId: player.id, reason } });
      this.emitMessage({ type: "world:entities", payload: this.entitySnapshot() });
      this.emitLeaderboard();
      return { ok: true, code: "accepted", details: { reason } };
    });
  }

  /**
   * Бустер, купленный игроком. Эффект применяет сервер: скорость, расход,
   * топливо и деньги — его зона ответственности, и начисленное клиентом
   * самому себе всё равно затёрлось бы ближайшим снапшотом.
   */
  reportBooster(playerId: string, requestId: string, systemName: string, cost = 0): GameEventResult {
    return this.processGameEvent(playerId, requestId, "booster-applied", (player) => {
      // Заглохшего игрока оживляет только канистра топлива — остальные бустеры
      // ему уже ни к чему.
      const revives = /^fuel(\d+(?:\.\d+)?)l$/.test(systemName);
      if (player.status !== "active" && !revives) return { ok: false, code: "player-inactive" };
      const price = Number.isFinite(cost) ? Math.max(0, Math.floor(cost)) : 0;
      if (price > player.money) return { ok: false, code: "not-enough-money" };
      const effect = this.applyBoosterEffect(player, systemName);
      if (!effect) return { ok: false, code: "unknown-booster" };
      player.money -= price;
      if (effect.revived) {
        this.emitMessage({ type: "player:respawned", payload: { player: publicPlayer(player) } });
        this.emitLeaderboard();
      }
      return {
        ok: true,
        code: "accepted",
        details: {
          systemName: effect.systemName,
          revived: effect.revived,
          spent: price,
          speedMultiplier: effect.speedMultiplier,
          fuelConsumptionMultiplier: effect.fuelConsumptionMultiplier,
        },
      };
    });
  }

  respawnPlayer(playerId: string, requestId: string): GameEventResult {
    return this.processGameEvent(playerId, requestId, "player-respawn", (player) => {
      if (player.status === "active") return { ok: false, code: "player-already-active" };
      const spawn = this.randomSpawn();
      player.x = spawn.x;
      player.y = spawn.y;
      player.angle = spawn.angle;
      player.speed = 0;
      player.fuel = Math.min(this.config.startFuel, this.config.startTankVolume);
      player.tankVolume = this.config.startTankVolume;
      player.money = this.config.startMoney;
      player.canisters = 0;
      player.filledLiters = 0;
      player.status = "active";
      player.input = emptyInput();
      player.lastMoveAt = Date.now();
      player.kx = 0;
      player.ky = 0;
      player.refueling = false;
      player.refuelStationId = null;
      player.refuelLiters = 0;
      player.refuelSpent = 0;
      player.usedStationId = null;
      player.speedMultiplier = 1;
      player.fuelConsumptionMultiplier = 1;
      this.refuelSessions.delete(player.id);
      this.refuelPlans.delete(player.id);
      this.emitMessage({ type: "player:respawned", payload: { player: publicPlayer(player) } });
      this.emitMessage({ type: "world:entities", payload: this.entitySnapshot() });
      this.emitLeaderboard();
      return { ok: true, code: "accepted", details: { x: spawn.x, y: spawn.y, angle: spawn.angle } };
    });
  }

  step(dt: number): void {
    const safeDt = clamp(dt, 0.001, 0.1);
    this.tickNumber += 1;
    // При задержке event loop один серверный тик может быть заметно длиннее
    // обычного. Делим его на шаги не больше клиентских 33 мс, чтобы быстрые
    // машины не успевали проскочить друг сквозь друга между проверками.
    const substeps = Math.max(1, Math.ceil(safeDt / (1 / 30)));
    const stepDt = safeDt / substeps;
    for (let index = 0; index < substeps; index += 1) {
      this.updateUnlockQueue(stepDt);
      this.updateBillboards(stepDt);
      for (const canister of this.city.canisters) canister.cool = Math.max(0, canister.cool - stepDt);
      for (const player of this.players.values()) if (player.status === "active") this.stepPlayer(player, stepDt);
      this.stepBots(stepDt);
      this.carCollisions();
    }

    if (this.objectsDirty) {
      this.objectsDirty = false;
      this.emitMessage({
        type: "world:objects",
        payload: {
          worldRevision: this.worldRevision,
          stations: this.city.stations,
          billboards: this.city.billboards,
          canisters: this.city.canisters,
        },
      });
    }

    // Столкновения отправляем сразу тем же тиком: искры, тряска и звук удара
    // должны совпасть с моментом удара, а не ждать очередного снапшота.
    if (this.collisionEvents.length > 0) {
      const collisions = this.collisionEvents;
      this.collisionEvents = [];
      this.emitMessage({ type: "world:collisions", payload: { tick: this.tickNumber, collisions } });
      // отскок меняет положение резко — клиенту нужны свежие координаты
      this.snapshotAccumulator = 0;
      this.emitMessage({ type: "world:entities", payload: this.entitySnapshot() });
    }

    this.snapshotAccumulator += safeDt;
    if (this.snapshotAccumulator >= 1 / this.config.snapshotRate) {
      this.snapshotAccumulator %= 1 / this.config.snapshotRate;
      this.emitMessage({ type: "world:entities", payload: this.entitySnapshot() });
    }
  }

  entitySnapshot(): EntitySnapshot {
    return {
      tick: this.tickNumber,
      serverTime: Date.now(),
      worldRevision: this.worldRevision,
      players: [...this.players.values()].filter((player) => player.status === "active").map(publicPlayer),
      bots: this.bots,
    };
  }

  worldSnapshot(): Extract<ServerMessage, { type: "world:snapshot" }> {
    return {
      type: "world:snapshot",
      payload: { map: this.city, entities: this.entitySnapshot(), leaderboard: this.leaderboard() },
    };
  }

  leaderboard(): LeaderboardEntry[] {
    return [
      ...[...this.players.values()].map((player, order) => ({
        entityId: player.id,
        name: player.name,
        liters: player.filledLiters,
        isPlayer: true,
        color: player.color,
        active: player.status === "active",
        order,
      })),
      ...this.bots.map((bot, order) => ({
        entityId: bot.id,
        name: bot.name,
        liters: bot.filledLiters,
        isPlayer: false,
        color: bot.color,
        active: true,
        order: this.players.size + order,
      })),
    ]
      .sort((left, right) => right.liters - left.liters || left.order - right.order)
      .map(({ order: _order, ...entry }, index) => ({ ...entry, position: index + 1 }));
  }

  getPublicPlayer(playerId: string): PublicPlayerState | null {
    const player = this.players.get(playerId);
    return player ? publicPlayer(player) : null;
  }

  private processGameEvent(
    playerId: string,
    requestId: string,
    event: GameEventName,
    handler: (player: PlayerState) => EventOutcome,
  ): GameEventResult {
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("player-not-found", "Player is not in the room");
    let playerResults = this.eventResults.get(playerId);
    if (!playerResults) {
      playerResults = new Map();
      this.eventResults.set(playerId, playerResults);
    }
    const cached = playerResults.get(requestId);
    if (cached) return cached;

    const outcome = handler(player);
    const payload: GameEventResult["payload"] = {
      requestId,
      event,
      ok: outcome.ok,
      code: outcome.code,
      player: publicPlayer(player),
    };
    if (outcome.details) payload.details = outcome.details;
    const result: GameEventResult = { type: "game:event-result", payload };
    if (playerResults.size >= 256) {
      const oldest = playerResults.keys().next().value as string | undefined;
      if (oldest) playerResults.delete(oldest);
    }
    playerResults.set(requestId, result);
    return result;
  }

  private emitLeaderboard(): void {
    this.emitMessage({ type: "leaderboard:update", payload: { rows: this.leaderboard() } });
  }

  private activateBillboard(player: PlayerState, billboardId: string): EventOutcome {
    const billboard = this.city.billboards.find((value) => value.id === billboardId);
    if (!billboard) return { ok: false, code: "object-not-found" };
    if (!nearRect(player, billboard, this.config.carRadius + 25)) return { ok: false, code: "too-far" };
    if (billboard.state !== "ready") return { ok: false, code: "billboard-cooldown" };
    if (!this.city.stations.some((station) => station.state === "locked")) {
      return { ok: false, code: "all-stations-active" };
    }
    billboard.state = "done";
    billboard.cooldown = this.config.billboardTimeout;
    billboard.discovered = true;
    if (!billboard.discoveredBy.includes(player.id)) billboard.discoveredBy.push(player.id);
    const unlocked = this.unlockRandomStation("ad");
    this.objectsDirty = true;
    return {
      ok: true,
      code: "accepted",
      details: { stationId: unlocked?.id ?? null, clientId: billboard.client.id },
    };
  }

  private uniqueName(rawName: string): string {
    const base = rawName.slice(0, 24) || "Игрок";
    const names = new Set([...this.players.values()].map((player) => player.name.toLocaleLowerCase("ru-RU")));
    if (!names.has(base.toLocaleLowerCase("ru-RU"))) return base;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const ending = ` #${suffix}`;
      const candidate = `${base.slice(0, 24 - ending.length)}${ending}`;
      if (!names.has(candidate.toLocaleLowerCase("ru-RU"))) return candidate;
    }
    return `Игрок ${this.players.size + 1}`;
  }

  private rebalanceForPlayerCount(fuelBonusPlayerIds: string[]): boolean {
    const nextScale = mapScaleForPlayers(this.players.size, this.config);
    if (nextScale === this.city.meta.scale) {
      this.reconcileBots();
      return false;
    }

    this.worldRevision += 1;
    this.city = buildCity(nextScale, this.worldRevision, this.config);
    initialiseStations(this.city, this.config);
    this.unlockQueue = [];
    this.refuelSessions.clear();
    this.refuelPlans.clear();
    const affectedPlayers: string[] = [];
    for (const playerId of fuelBonusPlayerIds) {
      const player = this.players.get(playerId);
      if (!player) continue;
      const added = Math.min(this.config.mapFuelBonus, Math.max(0, player.tankVolume - player.fuel));
      player.fuel += added;
      affectedPlayers.push(player.id);
    }
    for (const player of this.players.values()) {
      player.refueling = false;
      player.refuelStationId = null;
      player.refuelLiters = 0;
      player.refuelSpent = 0;
      player.usedStationId = null;
      player.x = clamp(player.x, this.config.carRadius + 20, this.city.meta.worldSize - this.config.carRadius - 20);
      player.y = clamp(player.y, this.config.carRadius + 20, this.city.meta.worldSize - this.config.carRadius - 20);
      player.lastMoveAt = Date.now();
      this.resolvePlayerCollisions(player);
    }
    this.bots = [];
    this.reconcileBots();
    this.emitMessage({
      type: "world:map-update",
      payload: {
        map: this.city,
        reason: "player-count",
        fuelBonus: this.config.mapFuelBonus,
        affectedPlayers,
      },
    });
    return true;
  }

  private reconcileBots(): void {
    const target = botCountForPlayers(this.players.size, this.config);
    if (this.bots.length > target) this.bots.splice(target);
    while (this.bots.length < target) {
      const occupied = [
        ...this.bots,
        ...[...this.players.values()].filter((player) => player.status === "active"),
      ];
      this.bots.push(createBot(this.bots.length, this.city, occupied, this.rng, this.config));
    }
  }

  private randomSpawn(excludePlayerId?: string): { x: number; y: number; angle: number } {
    const occupied = [
      ...this.bots,
      ...[...this.players.values()].filter(
        (player) => player.status === "active" && player.id !== excludePlayerId,
      ),
    ];
    return getRandomSpawn(this.city, this.rng, occupied);
  }

  private validateMovementHeader(player: PlayerState, seq: number, worldRevision: number): MovementResult {
    if (worldRevision !== this.worldRevision) return { ok: false, code: "stale-world" };
    if (seq <= player.lastInputSeq) return { ok: false, code: "stale-sequence" };
    return { ok: true, code: "accepted" };
  }

  private stepPlayer(player: PlayerState, dt: number): void {
    // Под колонкой машина стоит с заглушённым мотором: рулить нечем и топливо
    // не жжём — ровно как в офлайне.
    if (player.refueling) {
      player.speed = 0;
      this.updateRefuelling(player, dt);
      return;
    }

    const { input } = player;
    const maxSpeed = this.playerMaxSpeed(player);
    if (player.fuel > 0 && input.up) player.speed += this.config.acceleration * dt;
    if (input.down) {
      player.speed =
        player.speed > 1
          ? player.speed - this.config.brakeAcceleration * dt
          : player.fuel > 0
            ? player.speed - this.config.acceleration * 0.55 * dt
            : player.speed;
    }
    if (!input.up && !input.down) {
      player.speed -= Math.sign(player.speed) * Math.min(Math.abs(player.speed), (55 + Math.abs(player.speed) * 0.85) * dt);
    }
    if (input.handbrake) player.speed -= player.speed * 2.4 * dt;
    if (player.fuel <= 0) player.speed -= player.speed * Math.min(1, 1.5 * dt);
    if (!this.isOnRoad(player.x, player.y)) {
      const absolute = Math.abs(player.speed);
      player.speed -=
        Math.sign(player.speed) * Math.min(absolute, (absolute > 250 ? 560 : 150) * dt);
    }
    player.speed = clamp(player.speed, -this.config.reverseMaxSpeed, maxSpeed);

    const direction = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    let steeringGrip = grip(player.speed, maxSpeed);
    if (input.handbrake) steeringGrip *= 1.75;
    player.angle = normalizeAngle(
      player.angle + direction * 3.1 * steeringGrip * (player.speed < -1 ? -1 : 1) * dt,
    );
    player.x += Math.cos(player.angle) * player.speed * dt;
    player.y += Math.sin(player.angle) * player.speed * dt;
    this.applyPlayerKnock(player, dt);
    this.resolvePlayerCollisions(player);
    this.pickNearbyCanister(player);

    const speedRatio = Math.abs(player.speed) / maxSpeed;
    const burn =
      this.config.fuelBurnPerSecond *
      player.fuelConsumptionMultiplier *
      (0.09 + (input.up && player.fuel > 0 ? 0.42 + speedRatio * 0.49 : 0) + (input.handbrake && Math.abs(player.speed) > 250 ? 0.39 : 0));
    player.fuel = Math.max(0, player.fuel - burn * dt);

    this.updateRefuelling(player, dt);
  }

  private playerMaxSpeed(player: PlayerState): number {
    return this.config.maxSpeed * player.speedMultiplier;
  }

  private refuelDuration(canisters: number): number {
    return Math.max(
      0,
      this.config.stationTimeoutBase + this.config.stationTimeoutPerCanister * Math.max(0, canisters),
    );
  }

  /**
   * Заправка — порт updateFuel() из офлайн-движка клиента. Доступный объём
   * плавно наливается за T = base + perCanister * canisters. Колонку блокируем
   * сразу, а полный бак, лимит или деньги определяют целевой объём сессии.
   */
  private updateRefuelling(player: PlayerState, dt: number): void {
    const station = this.stationUnderPlayer(player);

    if (!player.refueling) {
      if (!station) {
        player.usedStationId = null;
        return;
      }
      // Повторно вставать под ту же колонку, не съехав с площадки, нельзя.
      if (station.state !== "active" || station.id === player.usedStationId) return;

      const room = player.tankVolume - player.fuel;
      const allowance = station.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, station.limit);
      const affordable = station.price > 0 ? player.money / station.price : Number.POSITIVE_INFINITY;
      const targetLiters = Math.max(0, Math.min(room, allowance, affordable));
      if (targetLiters <= 0.0005) {
        player.usedStationId = station.id;
        return;
      }

      const plan: RefuelPlan = {
        stationId: station.id,
        targetLiters,
        duration: this.refuelDuration(player.canisters),
        elapsed: 0,
        reason: room <= targetLiters + 0.0005 ? "full" : allowance <= targetLiters + 0.0005 ? "limit" : "money",
      };
      this.refuelPlans.set(player.id, plan);
      player.refueling = true;
      player.refuelStationId = station.id;
      player.refuelLiters = 0;
      player.refuelSpent = 0;
      player.speed = 0;
      player.kx = 0;
      player.ky = 0;
      this.takeStation(station, player.canisters);
      this.emitMessage({
        type: "player:refuel",
        payload: {
          playerId: player.id,
          stationId: station.id,
          state: "started",
          reason: null,
          liters: 0,
          spent: 0,
        },
      });
    }

    const plan = this.refuelPlans.get(player.id);
    if (!plan || !station || station.id !== plan.stationId) {
      this.finishRefuelling(player, "left");
      return;
    }

    const nextElapsed = plan.duration <= 0 ? plan.duration : Math.min(plan.duration, plan.elapsed + dt);
    const desiredLiters =
      plan.duration <= 0 ? plan.targetLiters : plan.targetLiters * (nextElapsed / plan.duration);
    const step = Math.max(0, Math.min(plan.targetLiters - player.refuelLiters, desiredLiters - player.refuelLiters));
    plan.elapsed = nextElapsed;

    const before = player.fuel;
    player.fuel = Math.min(player.tankVolume, player.fuel + step);
    const filled = player.fuel - before;
    const paid = filled * station.price;
    player.money = Math.max(0, player.money - paid);
    player.filledLiters += filled;
    player.refuelLiters += filled;
    player.refuelSpent += paid;
    if (filled > 0) this.emitLeaderboard();

    if (
      player.refuelLiters >= plan.targetLiters - 0.0005 ||
      plan.duration <= 0 ||
      plan.elapsed >= plan.duration
    ) {
      this.finishRefuelling(player, plan.reason);
    }
  }

  private finishRefuelling(player: PlayerState, reason: RefuelEvent["reason"]): void {
    const finishedStationId = player.refuelStationId;
    const liters = player.refuelLiters;
    const spent = player.refuelSpent;
    this.refuelPlans.delete(player.id);
    player.refueling = false;
    player.refuelStationId = null;
    player.usedStationId = finishedStationId;
    if (!finishedStationId) return;
    this.emitMessage({
      type: "player:refuel",
      payload: {
        playerId: player.id,
        stationId: finishedStationId,
        state: "stopped",
        reason,
        liters,
        spent,
      },
    });
  }

  /** Площадка АЗС, на которой сейчас стоит машина. Отступ тот же, что в офлайне. */
  private stationUnderPlayer(player: PlayerState): Station | null {
    if (player.fuel <= 0 && !player.refueling) return null;
    return (
      this.city.stations.find(
        (station) =>
          player.x > station.x - 6 &&
          player.x < station.x + station.w + 6 &&
          player.y > station.y - 6 &&
          player.y < station.y + station.h + 6,
      ) ?? null
    );
  }

  /** Открывает конкретную закрытую АЗС — это и делает бустер «Активировать эту АЗС». */
  private activateStation(station: Station, origin: "timer" | "ad"): boolean {
    if (station.state !== "locked") return false;
    station.state = "active";
    station.origin = origin;
    station.price = Math.round(
      this.config.stationPriceMin + this.rng.next() * (this.config.stationPriceMax - this.config.stationPriceMin),
    );
    station.limit = this.rng.bool(this.config.stationLimitChance) ? this.config.stationFuelLimit : null;
    this.objectsDirty = true;
    return true;
  }

  /**
   * Бустер: сервер — единственный источник правды по скорости, расходу,
   * топливу и деньгам, поэтому эффект применяем здесь. Иначе ближайший же
   * снапшот затирает то, что клиент начислил себе сам.
   */
  private applyBoosterEffect(player: PlayerState, systemName: string): BoosterEffect | null {
    const effect = (revived: boolean): BoosterEffect => ({
      systemName,
      revived,
      speedMultiplier: player.speedMultiplier,
      fuelConsumptionMultiplier: player.fuelConsumptionMultiplier,
    });

    const speed = /^speed(\d+(?:\.\d+)?)$/.exec(systemName);
    if (speed) {
      const percent = Number(speed[1]);
      if (!Number.isFinite(percent) || percent < 0 || percent > 500) return null;
      player.speedMultiplier = Math.max(player.speedMultiplier, 1 + percent / 100);
      return effect(false);
    }

    const consumption = /^consumption(\d+(?:\.\d+)?)$/.exec(systemName);
    if (consumption) {
      const percent = Number(consumption[1]);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
      player.fuelConsumptionMultiplier = Math.min(
        player.fuelConsumptionMultiplier,
        Math.max(0, 1 - percent / 100),
      );
      return effect(false);
    }

    const fuel = /^fuel(\d+(?:\.\d+)?)l$/.exec(systemName);
    if (fuel) {
      const liters = Number(fuel[1]);
      if (!Number.isFinite(liters) || liters <= 0 || liters > player.tankVolume) return null;
      const wasDown = player.fuel <= 0 || player.status !== "active";
      player.fuel = Math.min(player.tankVolume, player.fuel + liters);
      const revived = wasDown && player.fuel > 0;
      if (revived && player.status !== "active") {
        player.status = "active";
        player.speed = 0;
        player.lastMoveAt = Date.now();
      }
      return effect(revived);
    }

    const money = /^money(\d+(?:\.\d+)?)$/.exec(systemName);
    if (money) {
      const coefficient = Number(money[1]);
      if (!Number.isFinite(coefficient) || coefficient <= 0 || coefficient > 100) return null;
      player.money += Math.floor(this.config.startMoney * coefficient);
      return effect(false);
    }

    return null;
  }

  private stepBots(dt: number): void {
    let leaderboardChanged = false;
    for (const bot of this.bots) {
      const result = stepBot(bot, this.city, dt, this.rng, this.config);
      this.resolveBotCollisions(bot);
      if (result.canister) this.objectsDirty = true;
      if (result.station) {
        const requested = 18 + bot.taken * this.config.canisterTankBonus;
        bot.filledLiters += Math.min(requested, result.station.limit ?? requested);
        this.takeStation(result.station, bot.taken);
        leaderboardChanged = true;
      }
    }
    if (leaderboardChanged) this.emitLeaderboard();
  }

  private takeCanister(player: PlayerState, canisterId: string): boolean {
    const canister = this.city.canisters.find((value) => value.id === canisterId);
    if (!canister || canister.taken || canister.cool > 0) return false;
    canister.taken = true;
    player.canisters += 1;
    player.tankVolume += this.config.canisterTankBonus;
    this.objectsDirty = true;
    return true;
  }

  private pickNearbyCanister(player: PlayerState): void {
    const radiusSquared = (this.config.carRadius + this.config.canisterRadius) ** 2;
    for (const canister of this.city.canisters) {
      if (canister.taken || canister.cool > 0) continue;
      if ((player.x - canister.x) ** 2 + (player.y - canister.y) ** 2 <= radiusSquared) {
        this.takeCanister(player, canister.id);
      }
    }
  }

  private takeStation(station: Station, canisters: number): StationLockResult {
    if (station.state !== "active") return { locked: false, unlockIn: null };
    station.state = "locked";
    let unlockIn: number | null = null;
    if (station.origin !== "ad") {
      unlockIn = this.refuelDuration(canisters);
      this.unlockQueue.push({
        seconds: unlockIn,
        fromStationId: station.id,
      });
    }
    this.objectsDirty = true;
    return { locked: true, unlockIn };
  }

  private updateUnlockQueue(dt: number): void {
    for (let index = this.unlockQueue.length - 1; index >= 0; index -= 1) {
      const task = this.unlockQueue[index];
      if (!task) continue;
      task.seconds -= dt;
      if (task.seconds > 0) continue;
      this.unlockQueue.splice(index, 1);
      this.unlockRandomStation("timer", task.fromStationId);
    }
  }

  private updateBillboards(dt: number): void {
    for (const billboard of this.city.billboards) {
      if (billboard.state !== "done") continue;
      billboard.cooldown = Math.max(0, billboard.cooldown - dt);
      if (billboard.cooldown <= 0) {
        billboard.state = "ready";
        this.objectsDirty = true;
      }
    }
  }

  private unlockRandomStation(origin: "timer" | "ad", excludeStationId?: string): Station | null {
    let candidates = this.city.stations.filter((station) => station.state === "locked");
    if (excludeStationId && candidates.some((station) => station.id !== excludeStationId)) {
      candidates = candidates.filter((station) => station.id !== excludeStationId);
    }
    if (candidates.length === 0) return null;
    const station = this.rng.pick(candidates);
    station.state = "active";
    station.origin = origin;
    station.price = Math.round(
      this.config.stationPriceMin + this.rng.next() * (this.config.stationPriceMax - this.config.stationPriceMin),
    );
    station.limit = this.rng.bool(this.config.stationLimitChance) ? this.config.stationFuelLimit : null;
    this.objectsDirty = true;
    return station;
  }

  private isOnRoad(x: number, y: number): boolean {
    return this.city.roadCenters.some(
      (center) => Math.abs(x - center) < this.city.meta.roadWidth / 2 || Math.abs(y - center) < this.city.meta.roadWidth / 2,
    );
  }

  /** Отлёт игрока после тарана: гасим импульс и двигаем машину независимо от руля. */
  private applyPlayerKnock(player: PlayerState, dt: number): void {
    if (player.kx === 0 && player.ky === 0) return;
    player.x += player.kx * dt;
    player.y += player.ky * dt;
    const decay = Math.exp(-3.4 * dt);
    player.kx *= decay;
    player.ky *= decay;
    if (Math.hypot(player.kx, player.ky) < 4) {
      player.kx = 0;
      player.ky = 0;
    }
  }

  /**
   * Столкновения машин — порт carCollisions() из офлайн-движка клиента.
   * Считаем все пары «игрок/бот»: сначала расталкиваем кузова, потом смотрим,
   * кто в кого въехал, и уже таранившему даём отдачу, а протаранённому —
   * отлёт, стан и выпадение канистр.
   */
  private carCollisions(): void {
    const bodies: CollisionBody[] = [];
    for (const player of this.players.values()) {
      if (player.status !== "active") continue;
      bodies.push({
        id: player.id,
        x: player.x,
        y: player.y,
        vx: Math.cos(player.angle) * player.speed + player.kx,
        vy: Math.sin(player.angle) * player.speed + player.ky,
        // updateRefuelling() сразу переводит занятую станцию в locked, поэтому
        // проверка station.state === active ошибочно делала заправляющуюся
        // машину подвижной. Источник правды здесь — сама сессия игрока.
        fixed: player.refueling,
        player,
        bot: null,
      });
    }
    for (const bot of this.bots) {
      bodies.push({
        id: bot.id,
        x: bot.x,
        y: bot.y,
        vx: Math.cos(bot.angle) * bot.speed + bot.kx,
        vy: Math.sin(bot.angle) * bot.speed + bot.ky,
        fixed: bot.wait > 0,
        player: null,
        bot,
      });
    }

    const contact = COLLIDE_RADIUS * 2;
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= contact) continue;
        if (distance < 0.001) {
          dx = 1;
          dy = 0;
          distance = 0.001;
        }
        const nx = dx / distance;
        const ny = dy / distance;

        // расталкиваем, чтобы кузова не слипались
        const push = contact - distance;
        const weightA = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const weightB = b.fixed ? 0 : a.fixed ? 1 : 0.5;
        moveBody(a, -nx * push * weightA, -ny * push * weightA);
        moveBody(b, nx * push * weightB, ny * push * weightB);

        // кто в кого въехал: сравниваем сближение вдоль оси удара
        const intoB = a.vx * nx + a.vy * ny;
        const intoA = -(b.vx * nx + b.vy * ny);
        // едут рядом и лишь коснулись боками — просто разъезжаются, без тарана,
        // иначе машины в потоке бесконечно пинали бы друг друга
        if (Math.max(intoB, intoA) < RAM_MIN) continue;
        const aRams = intoB >= intoA;
        const rammer = aRams ? a : b;
        const victim = aRams ? b : a;
        const dirX = aRams ? nx : -nx;
        const dirY = aRams ? ny : -ny;
        const force = clamp(Math.max(intoB, intoA) * KICK, KICK_MIN, KICK_MAX);
        const contactX = a.x + nx * COLLIDE_RADIUS;
        const contactY = a.y + ny * COLLIDE_RADIUS;

        this.brakeRammer(rammer, -dirX * force * 0.16, -dirY * force * 0.16);

        let spilled = 0;
        // машина под колонкой — стенка: её не отбросить и канистры из неё не выбить
        if (!victim.fixed) {
          this.kickBody(victim, dirX * force, dirY * force);
          const carried = victim.bot ? victim.bot.taken : victim.player?.canisters ?? 0;
          if (carried > 0) spilled = this.spillCanisters(victim, carried, contactX, contactY);
        }

        this.collisionEvents.push({
          x: contactX,
          y: contactY,
          force,
          rammerId: rammer.id,
          victimId: victim.id,
          rammerIsPlayer: rammer.player !== null,
          victimIsPlayer: victim.player !== null,
          spilled,
        });
      }
    }
  }

  /** Протаранённому — отлёт: игрока просто отбрасывает, бота ещё и ведёт. */
  private kickBody(body: CollisionBody, kx: number, ky: number): void {
    if (body.fixed) return;
    if (body.bot) {
      body.bot.kx += kx;
      body.bot.ky += ky;
      body.bot.stun = STUN_SECONDS;
      body.bot.speed *= 0.4;
      body.bot.angle += (this.rng.next() - 0.5) * 0.9;
      body.bot.think = 0;
    } else if (body.player) {
      body.player.kx += kx;
      body.player.ky += ky;
      body.player.speed *= 0.45;
    }
  }

  /** Таранившему — отдача: скорость гаснет, но управление остаётся. */
  private brakeRammer(body: CollisionBody, kx: number, ky: number): void {
    if (body.fixed) return;
    if (body.bot) {
      body.bot.kx += kx;
      body.bot.ky += ky;
      body.bot.speed *= 0.55;
    } else if (body.player) {
      body.player.kx += kx;
      body.player.ky += ky;
      body.player.speed *= 0.6;
    }
  }

  /** Канистры протараненной машины разлетаются вокруг места удара. */
  private spillCanisters(victim: CollisionBody, count: number, x: number, y: number): number {
    const pool = this.city.canisters.filter((canister) => canister.taken);
    const drop = Math.min(count, pool.length);
    if (drop <= 0) return 0;
    for (let index = 0; index < drop; index += 1) {
      const canister = pool[index]!;
      const spot = this.spillSpot(x, y);
      canister.x = spot.x;
      canister.y = spot.y;
      canister.taken = false;
      canister.cool = CANISTER_COOL;
    }
    if (victim.bot) {
      victim.bot.taken -= drop;
      victim.bot.gotCanister = victim.bot.taken > 0;
      victim.bot.think = 0;
    } else if (victim.player) {
      // у игрока канистра — это ещё и +10 л к баку, значит бак сдувается обратно
      victim.player.canisters -= drop;
      victim.player.tankVolume = Math.max(
        this.config.startTankVolume,
        victim.player.tankVolume - drop * this.config.canisterTankBonus,
      );
      victim.player.fuel = Math.min(victim.player.fuel, victim.player.tankVolume);
    }
    this.objectsDirty = true;
    return drop;
  }

  /** Точка для выпавшей канистры: рядом с ударом, но не внутри здания. */
  private spillSpot(x: number, y: number): { x: number; y: number } {
    const worldSize = this.city.meta.worldSize;
    for (let tries = 0; tries < 12; tries += 1) {
      const angle = this.rng.next() * Math.PI * 2;
      const radius = SPILL_RADIUS * (0.35 + this.rng.next() * 0.65);
      const px = clamp(x + Math.cos(angle) * radius, 40, worldSize - 40);
      const py = clamp(y + Math.sin(angle) * radius, 40, worldSize - 40);
      const blocked = this.city.buildings.some(
        (building) =>
          px > building.x - 6 &&
          px < building.x + building.w + 6 &&
          py > building.y - 6 &&
          py < building.y + building.h + 6,
      );
      if (!blocked) return { x: px, y: py };
    }
    return { x: clamp(x, 40, worldSize - 40), y: clamp(y, 40, worldSize - 40) };
  }

  private resolvePlayerCollisions(player: PlayerState): void {
    let collided = false;
    for (const building of this.city.buildings) {
      if (resolveCircleRect(player, building, this.config.carRadius)) collided = true;
    }
    for (const billboard of this.city.billboards) {
      if (resolveCircleRect(player, billboard, this.config.carRadius)) collided = true;
    }
    for (const tree of this.city.trees) {
      const dx = player.x - tree.x;
      const dy = player.y - tree.y;
      const radius = this.config.carRadius + tree.r * 0.4;
      const distance = Math.hypot(dx, dy);
      if (distance >= radius || distance < 0.0001) continue;
      player.x += (dx / distance) * (radius - distance);
      player.y += (dy / distance) * (radius - distance);
      player.speed *= 0.72;
    }
    player.x = clamp(player.x, this.config.carRadius + 20, this.city.meta.worldSize - this.config.carRadius - 20);
    player.y = clamp(player.y, this.config.carRadius + 20, this.city.meta.worldSize - this.config.carRadius - 20);
    if (collided) player.speed *= Math.abs(player.speed) > 70 ? 0.42 : 0.78;
  }

  private resolveBotCollisions(bot: BotState): void {
    for (const building of this.city.buildings) {
      if (resolveCircleRect(bot, building, this.config.carRadius)) {
        bot.speed *= 0.55;
        bot.think = 0;
      }
    }
  }

  private emitMessage(message: ServerMessage): void {
    this.emit("message", message);
  }
}

function emptyInput(): PlayerInput {
  return { up: false, down: false, left: false, right: false, handbrake: false };
}

function publicPlayer(player: PlayerState): PublicPlayerState {
  const { input: _input, lastMoveAt: _lastMoveAt, ...publicState } = player;
  return publicState;
}

function moveBody(body: CollisionBody, dx: number, dy: number): void {
  if (!dx && !dy) return;
  body.x += dx;
  body.y += dy;
  if (body.bot) {
    body.bot.x = body.x;
    body.bot.y = body.y;
  } else if (body.player) {
    body.player.x = body.x;
    body.player.y = body.y;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function grip(speed: number, maxSpeed: number): number {
  const absolute = Math.abs(speed);
  return Math.min(absolute / 150, 1) * (1 - 0.42 * (absolute / maxSpeed));
}

function nearRect(point: { x: number; y: number }, rect: Rect, distance: number): boolean {
  const closestX = clamp(point.x, rect.x, rect.x + rect.w);
  const closestY = clamp(point.y, rect.y, rect.y + rect.h);
  return Math.hypot(point.x - closestX, point.y - closestY) <= distance || isInside(point, rect);
}

function resolveCircleRect(point: { x: number; y: number }, rect: Rect, radius: number): boolean {
  const closestX = clamp(point.x, rect.x, rect.x + rect.w);
  const closestY = clamp(point.y, rect.y, rect.y + rect.h);
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= radius * radius) return false;
  const distance = Math.sqrt(distanceSquared);
  if (distance < 0.001) {
    const left = point.x - rect.x;
    const right = rect.x + rect.w - point.x;
    const top = point.y - rect.y;
    const bottom = rect.y + rect.h - point.y;
    const minimum = Math.min(left, right, top, bottom);
    if (minimum === left) point.x = rect.x - radius;
    else if (minimum === right) point.x = rect.x + rect.w + radius;
    else if (minimum === top) point.y = rect.y - radius;
    else point.y = rect.y + rect.h + radius;
  } else {
    const push = (radius - distance) / distance;
    point.x += dx * push;
    point.y += dy * push;
  }
  return true;
}
