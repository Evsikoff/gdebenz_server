export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

export interface Client {
  id: string;
  name: string;
  mark: string;
  category: string;
  tagline: string;
  offer: string;
  color: string;
  ink: string;
  domain: string;
}

export interface Building extends Rect {
  id: string;
  c: string;
  hgt: number;
  winMask: number;
  vents: Array<[number, number, number]>;
}

export interface Billboard extends Rect {
  id: string;
  client: Client;
  /** Совместимое с локальным клиентом агрегированное состояние. */
  discovered: boolean;
  /** Multiplayer-расширение: кто именно уже активировал щит. */
  discoveredBy: string[];
  state: "ready" | "done";
  cooldown: number;
  vertical: boolean;
}

export interface Tree extends Point {
  id: string;
  r: number;
}

export interface Lamp extends Point {
  id: string;
}

export interface Park extends Rect {
  id: string;
  pond: ({ r: number } & Point) | null;
}

export type StationState = "locked" | "active";
export type StationOrigin = "start" | "timer" | "ad";

export interface Station extends Rect {
  id: string;
  corner: 0 | 1 | 2 | 3;
  bx: number;
  by: number;
  state: StationState;
  origin: StationOrigin;
  price: number;
  limit: number | null;
}

export interface Base extends Rect {
  id: "base";
  bx: number;
  by: number;
}

export interface Canister extends Point {
  id: string;
  taken: boolean;
  cool: number;
}

export interface WorldMeta {
  revision: number;
  seed: number;
  scale: number;
  grid: number;
  worldSize: number;
  blockSize: number;
  roadWidth: number;
}

/** Совместимая с клиентским City структура с дополнительными стабильными id. */
export interface City {
  meta: WorldMeta;
  blocks: Rect[];
  parks: Park[];
  buildings: Building[];
  billboards: Billboard[];
  trees: Tree[];
  lamps: Lamp[];
  stations: Station[];
  base: Base;
  canisters: Canister[];
  roadCenters: number[];
}

export interface PlayerInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  handbrake: boolean;
}

export type PlayerStatus = "active" | "lost";

export interface PlayerState extends Point {
  id: string;
  name: string;
  angle: number;
  speed: number;
  color: string;
  fuel: number;
  tankVolume: number;
  money: number;
  canisters: number;
  filledLiters: number;
  status: PlayerStatus;
  input: PlayerInput;
  lastInputSeq: number;
  lastMoveAt: number;
}

export type BotPlan = "station" | "canister";

export interface BotState extends Point {
  id: string;
  name: string;
  angle: number;
  speed: number;
  color: string;
  filledLiters: number;
  plan: BotPlan;
  goal: BotGoal | null;
  gotCanister: boolean;
  refuelled: boolean;
  wait: number;
  think: number;
  taken: number;
  style: number;
  lane: number;
  wobble: number;
}

export type BotGoal =
  | { kind: "station"; id: string; x: number; y: number }
  | { kind: "canister"; id: string; x: number; y: number }
  | { kind: "base"; x: number; y: number }
  | { kind: "wander"; x: number; y: number };

export interface PublicPlayerState extends Omit<PlayerState, "input" | "lastMoveAt"> {}

export interface LeaderboardEntry {
  entityId: string;
  name: string;
  liters: number;
  isPlayer: boolean;
  color: string;
  position: number;
  active: boolean;
}

export interface EntitySnapshot {
  tick: number;
  serverTime: number;
  worldRevision: number;
  players: PublicPlayerState[];
  bots: BotState[];
}
