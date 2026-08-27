/** Небольшой детерминированный ГПСЧ, совпадающий с генератором клиента. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * Math.max(1, maxExclusive));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    const value = items[this.int(items.length)];
    if (value === undefined) throw new Error("Cannot pick from an empty list");
    return value;
  }

  shuffle<T>(items: T[]): T[] {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = this.int(index + 1);
      [items[index], items[other]] = [items[other]!, items[index]!];
    }
    return items;
  }
}
