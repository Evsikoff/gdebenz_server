/**
 * Игровые настройки сервера.
 *
 * Единицы совпадают с клиентом citi_ads: время — секунды, топливо — литры,
 * деньги — рубли, расстояния — пиксели мировых координат.
 */
export interface GameConfig {
  /** Максимальное число участников, которое сервер дополняет ботами. */
  botCount: number;
  fuelBurnPerSecond: number;
  stationTimeoutBase: number;
  stationTimeoutPerCanister: number;
  billboardTimeout: number;
  startFuel: number;
  startTankVolume: number;
  startMoney: number;
  fuelSellPrice: number;
  stationPriceMin: number;
  stationPriceMax: number;
  stationFuelLimit: number;
  stationLimitChance: number;

  /** Настройки карты, повторяющие базовую карту клиента. */
  blockSize: number;
  roadWidth: number;
  baseGridSize: number;
  stationsPerBaseMap: number;
  canistersPerBaseMap: number;
  billboardsPerClient: number;
  mapScaleThreshold: number;
  mapFuelBonus: number;
  worldSeed: number;

  /** Физика и сетевой цикл. */
  maxSpeed: number;
  acceleration: number;
  brakeAcceleration: number;
  reverseMaxSpeed: number;
  carRadius: number;
  canisterRadius: number;
  canisterTankBonus: number;
  refuelRate: number;
  tickRate: number;
  snapshotRate: number;
  maxPlayers: number;
  maxClientMessageBytes: number;
}

export const CONFIG: Readonly<GameConfig> = Object.freeze({
  botCount: 10,
  fuelBurnPerSecond: 0.57,
  stationTimeoutBase: 1,
  stationTimeoutPerCanister: 1,
  billboardTimeout: 20,
  startFuel: 50,
  startTankVolume: 50,
  startMoney: 10_000,
  fuelSellPrice: 200,
  stationPriceMin: 70,
  stationPriceMax: 120,
  stationFuelLimit: 20,
  stationLimitChance: 0.2,

  blockSize: 860,
  roadWidth: 170,
  baseGridSize: 10,
  stationsPerBaseMap: 20,
  canistersPerBaseMap: 12,
  billboardsPerClient: 4,
  mapScaleThreshold: 2,
  mapFuelBonus: 10,
  worldSeed: 20_260_214,

  maxSpeed: 640,
  acceleration: 540,
  brakeAcceleration: 780,
  reverseMaxSpeed: 215,
  carRadius: 15,
  canisterRadius: 20,
  canisterTankBonus: 10,
  refuelRate: 10,
  tickRate: 30,
  snapshotRate: 10,
  maxPlayers: 200,
  maxClientMessageBytes: 16 * 1024,
});

/**
 * Масштаб стороны карты. До отношения players / botCount <= 2 карта остаётся
 * базовой; затем отношение округляется вниз, как задано в требованиях.
 */
export function mapScaleForPlayers(playerCount: number, config: GameConfig = CONFIG): number {
  if (config.botCount <= 0 || playerCount <= 0) return 1;
  const ratio = playerCount / config.botCount;
  return ratio > config.mapScaleThreshold ? Math.max(1, Math.floor(ratio)) : 1;
}

export function botCountForPlayers(playerCount: number, config: GameConfig = CONFIG): number {
  return Math.max(0, config.botCount - playerCount);
}
