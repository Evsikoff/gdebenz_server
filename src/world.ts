import { CONFIG, type GameConfig } from "./config.js";
import { CLIENTS } from "./clients.js";
import { Random } from "./random.js";
import type {
  Base,
  Billboard,
  Building,
  Canister,
  City,
  Lamp,
  Park,
  Rect,
  Station,
  Tree,
} from "./types.js";

const SIDEWALK = 26;
const BUILD_INSET = 96;
const STATION_PAD = 160;
const BASE_W = 300;
const BASE_H = 200;
const STATION_MARGIN = 30;
const BILLBOARD_W = 132;
const BILLBOARD_H = 72;

const WALL_COLORS = [
  "#67584f",
  "#5a6673",
  "#6d6a54",
  "#5d6f60",
  "#705a63",
  "#605d70",
  "#6b6157",
  "#54616b",
  "#77624f",
  "#4f6b6b",
] as const;

interface Candidate {
  x: number;
  y: number;
  vertical: boolean;
}

interface BlockSpot {
  gx: number;
  gy: number;
  corner: 0 | 1 | 2 | 3;
}

const hit = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const grow = (rect: Rect, amount: number): Rect => ({
  x: rect.x - amount,
  y: rect.y - amount,
  w: rect.w + amount * 2,
  h: rect.h + amount * 2,
});

const centerDistance = (a: Rect, b: Rect): number =>
  Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

/** Точка появления совпадает с локальной игрой при scale=1. */
export function getSpawn(city: City): { x: number; y: number; angle: number } {
  const x = city.meta.roadWidth / 2 + Math.floor(city.meta.grid / 2) * (city.meta.blockSize + city.meta.roadWidth);
  return { x, y: city.meta.worldSize * 0.62, angle: -Math.PI / 2 };
}

/**
 * Детерминированная карта в формате клиентского City. Масштаб означает
 * увеличение каждой стороны; площадь и число объектов растут как scale².
 */
export function buildCity(scale = 1, revision = 1, config: GameConfig = CONFIG): City {
  const safeScale = Math.max(1, Math.floor(scale));
  const areaScale = safeScale * safeScale;
  const grid = config.baseGridSize * safeScale;
  const worldSize = grid * config.blockSize + (grid + 1) * config.roadWidth;
  const rng = new Random(config.worldSeed + safeScale * 10_007);

  const roadCenters = Array.from(
    { length: grid + 1 },
    (_, index) => config.roadWidth / 2 + index * (config.blockSize + config.roadWidth),
  );

  const blocks: Rect[] = [];
  const parks: Park[] = [];
  const buildings: Building[] = [];
  const trees: Tree[] = [];

  for (let gx = 0; gx < grid; gx += 1) {
    for (let gy = 0; gy < grid; gy += 1) {
      const x = config.roadWidth + gx * (config.blockSize + config.roadWidth);
      const y = config.roadWidth + gy * (config.blockSize + config.roadWidth);
      const block = { x, y, w: config.blockSize, h: config.blockSize };
      blocks.push(block);

      if (rng.bool(0.24)) {
        const pond = rng.bool(0.55)
          ? {
              x: x + config.blockSize * (0.32 + rng.next() * 0.36),
              y: y + config.blockSize * (0.32 + rng.next() * 0.36),
              r: 70 + rng.next() * 55,
            }
          : null;
        parks.push({ id: `park:${gx}:${gy}`, ...block, pond });
        const treeCount = 10 + rng.int(6);
        for (let index = 0; index < treeCount; index += 1) {
          const tx = x + 60 + rng.next() * (config.blockSize - 120);
          const ty = y + 60 + rng.next() * (config.blockSize - 120);
          if (pond && Math.hypot(tx - pond.x, ty - pond.y) < pond.r + 34) continue;
          trees.push({ id: `tree:${gx}:${gy}:${index}`, x: tx, y: ty, r: 16 + rng.next() * 15 });
        }
        continue;
      }

      const inner = config.blockSize - BUILD_INSET * 2;
      const gap = 24;
      const cell = (inner - gap) / 2;
      for (let cellX = 0; cellX < 2; cellX += 1) {
        for (let cellY = 0; cellY < 2; cellY += 1) {
          if (rng.bool(0.14)) continue;
          const pad = 10 + rng.next() * 26;
          const w = cell - pad * 2;
          const h = cell - pad * 2;
          const buildingX = x + BUILD_INSET + cellX * (cell + gap) + pad;
          const buildingY = y + BUILD_INSET + cellY * (cell + gap) + pad;
          let winMask = 0;
          for (let bit = 0; bit < 10; bit += 1) if (rng.bool(0.62)) winMask |= 1 << bit;
          const vents: Array<[number, number, number]> = [];
          const ventCount = 1 + rng.int(3);
          for (let vent = 0; vent < ventCount; vent += 1) {
            vents.push([14 + rng.next() * (w - 60), 14 + rng.next() * (h - 60), 16 + rng.next() * 16]);
          }
          buildings.push({
            id: `building:${gx}:${gy}:${cellX}:${cellY}`,
            x: buildingX,
            y: buildingY,
            w,
            h,
            c: rng.pick(WALL_COLORS),
            hgt: 20 + rng.next() * 28,
            winMask,
            vents,
          });
          if (rng.bool(0.5)) {
            trees.push({
              id: `yard-tree:${gx}:${gy}:${cellX}:${cellY}`,
              x: buildingX - 26 + rng.next() * 20,
              y: buildingY + rng.next() * h,
              r: 13 + rng.next() * 8,
            });
          }
        }
      }
    }
  }

  const isParkBlock = (block: Rect): boolean => parks.some((park) => park.x === block.x && park.y === block.y);
  const stationSpots: BlockSpot[] = [];
  for (let gx = 0; gx < grid; gx += 1) {
    for (let gy = 0; gy < grid; gy += 1) {
      stationSpots.push({ gx, gy, corner: rng.int(4) as 0 | 1 | 2 | 3 });
    }
  }
  rng.shuffle(stationSpots);

  const stationTarget = config.stationsPerBaseMap * areaScale;
  const stations: Station[] = [];
  for (let apart = config.blockSize * 1.7; stations.length < stationTarget && apart > 80; apart *= 0.72) {
    stations.length = 0;
    for (const spot of stationSpots) {
      if (stations.length >= stationTarget) break;
      const block = blocks[spot.gx * grid + spot.gy];
      if (!block || isParkBlock(block)) continue;
      const x =
        spot.corner === 1 || spot.corner === 3
          ? block.x + config.blockSize - STATION_PAD - STATION_MARGIN
          : block.x + STATION_MARGIN;
      const y =
        spot.corner === 2 || spot.corner === 3
          ? block.y + config.blockSize - STATION_PAD - STATION_MARGIN
          : block.y + STATION_MARGIN;
      const pad = { x, y, w: STATION_PAD, h: STATION_PAD };
      if (stations.some((station) => hit(grow(station, apart), pad))) continue;
      stations.push({
        id: `station:${spot.gx}:${spot.gy}`,
        ...pad,
        corner: spot.corner,
        bx: block.x,
        by: block.y,
        state: "locked",
        origin: "start",
        price: randomStationPrice(rng, config),
        limit: rng.bool(config.stationLimitChance) ? config.stationFuelLimit : null,
      });
    }
  }

  removeBlockedDecorations(buildings, trees, stations);
  const lamps = buildLamps(roadCenters, worldSize, config.roadWidth);
  const billboards = buildBillboards(blocks, stations, areaScale, rng, config);
  const base = buildBase(blocks, parks, stations, billboards, buildings, trees, grid, rng, config);
  const canisters = buildCanisters(roadCenters, worldSize, areaScale, rng, config);

  return {
    meta: {
      revision,
      seed: config.worldSeed,
      scale: safeScale,
      grid,
      worldSize,
      blockSize: config.blockSize,
      roadWidth: config.roadWidth,
    },
    blocks,
    parks,
    buildings,
    billboards,
    trees,
    lamps,
    stations,
    base,
    canisters,
    roadCenters,
  };
}

function randomStationPrice(rng: Random, config: GameConfig): number {
  const range = Math.max(0, config.stationPriceMax - config.stationPriceMin);
  return Math.round(config.stationPriceMin + rng.next() * range);
}

function removeBlockedDecorations(buildings: Building[], trees: Tree[], stations: Station[]): void {
  for (let index = buildings.length - 1; index >= 0; index -= 1) {
    const building = buildings[index];
    if (building && stations.some((station) => hit(grow(station, SIDEWALK), building))) buildings.splice(index, 1);
  }
  for (let index = trees.length - 1; index >= 0; index -= 1) {
    const tree = trees[index];
    if (
      tree &&
      stations.some(
        (station) =>
          tree.x > station.x - 24 &&
          tree.x < station.x + station.w + 24 &&
          tree.y > station.y - 24 &&
          tree.y < station.y + station.h + 24,
      )
    ) {
      trees.splice(index, 1);
    }
  }
}

function buildLamps(roadCenters: number[], worldSize: number, roadWidth: number): Lamp[] {
  const lamps: Lamp[] = [];
  const nearCenter = (value: number): boolean => roadCenters.some((center) => Math.abs(value - center) < roadWidth);
  for (let roadIndex = 0; roadIndex < roadCenters.length; roadIndex += 1) {
    const center = roadCenters[roadIndex]!;
    for (let along = roadWidth; along < worldSize - roadWidth; along += 520) {
      const side = (Math.floor(along / 520) + roadIndex) % 2 === 0 ? 1 : -1;
      if (!nearCenter(along)) {
        lamps.push({ id: `lamp:v:${roadIndex}:${along}`, x: center + side * (roadWidth / 2 - 15), y: along });
      }
      const other = Math.min(worldSize - roadWidth, along + 260);
      if (!nearCenter(other)) {
        lamps.push({ id: `lamp:h:${roadIndex}:${along}`, x: other, y: center + side * (roadWidth / 2 - 15) });
      }
    }
  }
  return lamps;
}

function buildBillboards(
  blocks: Rect[],
  stations: Station[],
  areaScale: number,
  rng: Random,
  config: GameConfig,
): Billboard[] {
  const candidates: Candidate[] = [];
  for (const block of blocks) {
    const horizontalX = (): number => block.x + config.blockSize * (0.3 + rng.next() * 0.4);
    const verticalY = (): number => block.y + config.blockSize * (0.3 + rng.next() * 0.4);
    candidates.push({ x: horizontalX() - BILLBOARD_W / 2, y: block.y + 4, vertical: false });
    candidates.push({
      x: horizontalX() - BILLBOARD_W / 2,
      y: block.y + config.blockSize - BILLBOARD_H - 4,
      vertical: false,
    });
    candidates.push({ x: block.x + 4, y: verticalY() - BILLBOARD_H / 2, vertical: true });
    candidates.push({
      x: block.x + config.blockSize - BILLBOARD_W - 4,
      y: verticalY() - BILLBOARD_H / 2,
      vertical: true,
    });
  }

  const available = candidates.filter((candidate) => {
    const rect = candidate.vertical
      ? { x: candidate.x, y: candidate.y, w: BILLBOARD_H, h: BILLBOARD_W }
      : { x: candidate.x, y: candidate.y, w: BILLBOARD_W, h: BILLBOARD_H };
    return !stations.some((station) => hit(grow(station, 60), rect));
  });
  rng.shuffle(available);

  const target = CLIENTS.length * config.billboardsPerClient * areaScale;
  const selected: Candidate[] = [];
  for (let spacing = 780; selected.length < target && spacing >= 100; spacing *= 0.72) {
    selected.length = 0;
    for (const candidate of available) {
      if (selected.length >= target) break;
      const cx = candidate.x + (candidate.vertical ? BILLBOARD_H : BILLBOARD_W) / 2;
      const cy = candidate.y + (candidate.vertical ? BILLBOARD_W : BILLBOARD_H) / 2;
      if (
        selected.some((other) => {
          const ox = other.x + (other.vertical ? BILLBOARD_H : BILLBOARD_W) / 2;
          const oy = other.y + (other.vertical ? BILLBOARD_W : BILLBOARD_H) / 2;
          return Math.hypot(cx - ox, cy - oy) < spacing;
        })
      ) {
        continue;
      }
      selected.push(candidate);
    }
  }

  return selected.map((candidate, index) => {
    const client = CLIENTS[index % CLIENTS.length]!;
    return {
      id: `billboard:${index}`,
      x: candidate.x,
      y: candidate.y,
      w: candidate.vertical ? BILLBOARD_H : BILLBOARD_W,
      h: candidate.vertical ? BILLBOARD_W : BILLBOARD_H,
      client,
      discovered: false,
      discoveredBy: [],
      state: "ready",
      cooldown: 0,
      vertical: candidate.vertical,
    };
  });
}

function buildBase(
  blocks: Rect[],
  parks: Park[],
  stations: Station[],
  billboards: Billboard[],
  buildings: Building[],
  trees: Tree[],
  grid: number,
  rng: Random,
  config: GameConfig,
): Base {
  const spots: BlockSpot[] = [];
  for (let gx = 0; gx < grid; gx += 1) {
    for (let gy = 0; gy < grid; gy += 1) spots.push({ gx, gy, corner: rng.int(4) as 0 | 1 | 2 | 3 });
  }
  rng.shuffle(spots);

  let base: Base | null = null;
  for (let distanceFactor = 1; !base && distanceFactor > 0.2; distanceFactor *= 0.72) {
    for (const spot of spots) {
      const block = blocks[spot.gx * grid + spot.gy];
      if (!block || parks.some((park) => park.x === block.x && park.y === block.y)) continue;
      const x =
        spot.corner === 1 || spot.corner === 3
          ? block.x + config.blockSize - BASE_W - STATION_MARGIN
          : block.x + STATION_MARGIN;
      const y =
        spot.corner === 2 || spot.corner === 3
          ? block.y + config.blockSize - BASE_H - STATION_MARGIN
          : block.y + STATION_MARGIN;
      const candidate: Base = { id: "base", x, y, w: BASE_W, h: BASE_H, bx: block.x, by: block.y };
      if (stations.some((station) => centerDistance(station, candidate) < 1_800 * distanceFactor)) continue;
      if (billboards.some((billboard) => centerDistance(billboard, candidate) < 700 * distanceFactor)) continue;
      base = candidate;
      break;
    }
  }
  base ??= {
    id: "base",
    x: config.roadWidth,
    y: config.roadWidth,
    w: BASE_W,
    h: BASE_H,
    bx: config.roadWidth,
    by: config.roadWidth,
  };

  for (let index = buildings.length - 1; index >= 0; index -= 1) {
    const building = buildings[index];
    if (building && hit(grow(base, SIDEWALK), building)) buildings.splice(index, 1);
  }
  for (let index = trees.length - 1; index >= 0; index -= 1) {
    const tree = trees[index];
    if (
      tree &&
      tree.x > base.x - 24 &&
      tree.x < base.x + base.w + 24 &&
      tree.y > base.y - 24 &&
      tree.y < base.y + base.h + 24
    ) {
      trees.splice(index, 1);
    }
  }
  return base;
}

function buildCanisters(
  roadCenters: number[],
  worldSize: number,
  areaScale: number,
  rng: Random,
  config: GameConfig,
): Canister[] {
  const onCrossing = (value: number): boolean =>
    roadCenters.some((center) => Math.abs(value - center) < config.roadWidth * 0.9);
  const spots: Array<{ x: number; y: number }> = [];
  for (const center of roadCenters) {
    for (let along = config.roadWidth; along < worldSize - config.roadWidth; along += 190) {
      if (onCrossing(along)) continue;
      spots.push({ x: center + (rng.next() - 0.5) * (config.roadWidth - 90), y: along });
      spots.push({ x: along, y: center + (rng.next() - 0.5) * (config.roadWidth - 90) });
    }
  }
  rng.shuffle(spots);

  const target = config.canistersPerBaseMap * areaScale;
  const selected: Array<{ x: number; y: number }> = [];
  for (let spacing = 1_400; selected.length < target && spacing >= 40; spacing *= 0.7) {
    selected.length = 0;
    for (const spot of spots) {
      if (selected.length >= target) break;
      if (selected.some((other) => Math.hypot(other.x - spot.x, other.y - spot.y) < spacing)) continue;
      selected.push(spot);
    }
  }
  return selected.map((spot, index) => ({ id: `canister:${index}`, ...spot, taken: false, cool: 0 }));
}

export function initialiseStations(city: City, config: GameConfig = CONFIG): void {
  const spawn = getSpawn(city);
  let nearest: Station | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const station of city.stations) {
    station.state = "locked";
    station.origin = "start";
    const candidate = Math.hypot(station.x + station.w / 2 - spawn.x, station.y + station.h / 2 - spawn.y);
    if (candidate < distance) {
      distance = candidate;
      nearest = station;
    }
  }
  if (nearest) {
    nearest.state = "active";
    const offerRng = new Random(config.worldSeed ^ city.meta.revision);
    nearest.price = randomStationPrice(offerRng, config);
    nearest.limit = offerRng.bool(config.stationLimitChance) ? config.stationFuelLimit : null;
  }
}

export function isInside(point: { x: number; y: number }, rect: Rect, padding = 6): boolean {
  return (
    point.x > rect.x - padding &&
    point.x < rect.x + rect.w + padding &&
    point.y > rect.y - padding &&
    point.y < rect.y + rect.h + padding
  );
}

export function nearestRoadCenter(city: City, value: number): number {
  let best = city.roadCenters[0] ?? city.meta.roadWidth / 2;
  for (const center of city.roadCenters) if (Math.abs(center - value) < Math.abs(best - value)) best = center;
  return best;
}
