import { ReadableStream } from "node:stream/web";
/** A pull-driven queue. No hidden ReadableStream prefetch; all retained values count. */
export class BoundedStream<T> {
  private queue: T[] = [];
  private bytes = 0;
  private ended = false;
  private controller?: ReadableStreamDefaultController<T>;
  private waiting = false;
  readonly stream: ReadableStream<T>;
  constructor(
    private size: (value: T) => number,
    private limit: number,
    private overflow: () => void,
  ) {
    this.stream = new ReadableStream<T>(
      {
        start: (c) => {
          this.controller = c;
        },
        pull: () => {
          this.waiting = true;
          this.drain();
        },
        cancel: () => this.discard(),
      },
      { highWaterMark: 0 },
    );
  }
  push(value: T): void {
    if (this.ended) return;
    const size = this.size(value);
    if (size > this.limit - this.bytes) {
      this.discard();
      this.overflow();
      return;
    }
    this.queue.push(value);
    this.bytes += size;
    this.drain();
  }
  get retainedBytes() {
    return this.bytes;
  }
  end(): void {
    this.ended = true;
    this.drain();
  }
  discard(): void {
    this.queue = [];
    this.bytes = 0;
    this.ended = true;
    this.drain();
  }
  private drain() {
    if (this.waiting && this.queue.length) {
      const value = this.queue.shift()!;
      this.bytes -= this.size(value);
      this.waiting = false;
      this.controller!.enqueue(value);
    }
    if (this.ended && !this.queue.length) {
      try {
        this.controller!.close();
      } catch {}
      this.controller = undefined;
    }
  }
}
