/**
 * Fixed-capacity circular buffer. Oldest samples are overwritten once the
 * capacity is reached, so memory stays bounded however long the page lives.
 */
export class Ring<T> {
  private readonly items: (T | undefined)[];
  private head = 0; // index of the next write
  private count = 0;

  constructor(readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Oldest to newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out[i] = this.items[(start + i) % this.capacity] as T;
    return out;
  }

  last(): T | undefined {
    if (this.count === 0) return undefined;
    return this.items[(this.head - 1 + this.capacity) % this.capacity];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.items.fill(undefined);
  }
}
