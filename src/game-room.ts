import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { botCountForPlayers, CONFIG, mapScaleForPlayers, type GameConfig } from "./config.js";
import { createBot, stepBot } from "./bots.js";
import type { ObjectType, ServerMessage } from "./protocol.js";
import { Random } from "./random.js";
import type {
  BotState,
  City,
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

interface UnlockTask {
  seconds: number;
  fromStationId: string;
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
        if (station.state !== "active") return failure("station-locked");
        const room = Math.max(0, player.tankVolume - player.fuel);
        const requested = request.amount ?? room;
        const allowance = station.limit ?? Number.POSITIVE_INFINITY;
        const affordable = station.price > 0 ? player.money / station.price : Number.POSITIVE_INFINITY;
        const liters = Math.max(0, Math.min(requested, room, allowance, affordable));
        if (liters <= 0.0005) return failure(room <= 0.0005 ? "tank-full" : "not-enough-money");
        player.fuel += liters;
        player.money = Math.max(0, player.money - liters * station.price);
        player.filledLiters += liters;
        const lock = this.takeStation(station, player.canisters);
        details = { liters, spent: liters * station.price, price: station.price, unlockIn: lock.unlockIn };
        this.emitLeaderboard();
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
      this.emitMessage({ type: "player:despawned", payload: { playerId: player.id, reason } });
      this.emitMessage({ type: "world:entities", payload: this.entitySnapshot() });
      this.emitLeaderboard();
      return { ok: true, code: "accepted", details: { reason } };
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
      this.refuelSessions.delete(player.id);
      this.emitMessage({ type: "player:respawned", payload: { player: publicPlayer(player) } });
      this.emitMessage({ type: "world:entities", payload: this.entitySnapshot() });
      this.emitLeaderboard();
      return { ok: true, code: "accepted", details: { x: spawn.x, y: spawn.y, angle: spawn.angle } };
    });
  }

  step(dt: number): void {
    const safeDt = clamp(dt, 0.001, 0.1);
    this.tickNumber += 1;
    this.updateUnlockQueue(safeDt);
    this.updateBillboards(safeDt);
    for (const canister of this.city.canisters) canister.cool = Math.max(0, canister.cool - safeDt);
    for (const player of this.players.values()) if (player.status === "active") this.stepPlayer(player, safeDt);
    this.stepBots(safeDt);

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
    const affectedPlayers: string[] = [];
    for (const playerId of fuelBonusPlayerIds) {
      const player = this.players.get(playerId);
      if (!player) continue;
      const added = Math.min(this.config.mapFuelBonus, Math.max(0, player.tankVolume - player.fuel));
      player.fuel += added;
      affectedPlayers.push(player.id);
    }
    for (const player of this.players.values()) {
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
    const { input } = player;
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
    player.speed = clamp(player.speed, -this.config.reverseMaxSpeed, this.config.maxSpeed);

    const direction = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    let steeringGrip = grip(player.speed, this.config.maxSpeed);
    if (input.handbrake) steeringGrip *= 1.75;
    player.angle = normalizeAngle(
      player.angle + direction * 3.1 * steeringGrip * (player.speed < -1 ? -1 : 1) * dt,
    );
    player.x += Math.cos(player.angle) * player.speed * dt;
    player.y += Math.sin(player.angle) * player.speed * dt;
    this.resolvePlayerCollisions(player);
    this.pickNearbyCanister(player);

    const speedRatio = Math.abs(player.speed) / this.config.maxSpeed;
    const burn =
      this.config.fuelBurnPerSecond *
      (0.09 + (input.up && player.fuel > 0 ? 0.42 + speedRatio * 0.49 : 0) + (input.handbrake && Math.abs(player.speed) > 250 ? 0.39 : 0));
    player.fuel = Math.max(0, player.fuel - burn * dt);
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
      unlockIn = this.config.stationTimeoutBase + this.config.stationTimeoutPerCanister * canisters;
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
