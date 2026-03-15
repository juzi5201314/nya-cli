export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => number;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export class RateGate {
  private nextAllowedAtMs = 0;
  private readonly queue = new SerialQueue();

  constructor(
    private readonly unitsPerMinute: number,
    private readonly deps: {
      now?: NowFn;
      sleep?: SleepFn;
    } = {}
  ) {}

  async acquire(units: number): Promise<void> {
    if (!Number.isFinite(units) || units <= 0) {
      return;
    }
    if (!Number.isFinite(this.unitsPerMinute) || this.unitsPerMinute <= 0) {
      return;
    }

    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? defaultSleep;

    await this.queue.run(async () => {
      const current = now();
      if (this.nextAllowedAtMs < current) {
        this.nextAllowedAtMs = current;
      }

      const waitMs = this.nextAllowedAtMs - current;
      const durationMs = Math.ceil((units / this.unitsPerMinute) * 60_000);
      this.nextAllowedAtMs += Math.max(0, durationMs);

      if (waitMs > 0) {
        await sleep(waitMs);
      }
    });
  }
}

export class RateLimiter {
  private readonly requestGate: RateGate | null;
  private readonly tokenGate: RateGate | null;

  constructor(
    config: {
      rpm: number;
      tpm: number;
    },
    deps: {
      now?: NowFn;
      sleep?: SleepFn;
    } = {}
  ) {
    this.requestGate =
      Number.isFinite(config.rpm) && config.rpm > 0
        ? new RateGate(config.rpm, deps)
        : null;
    this.tokenGate =
      Number.isFinite(config.tpm) && config.tpm > 0
        ? new RateGate(config.tpm, deps)
        : null;
  }

  async acquire(args: { requests?: number; tokens?: number }): Promise<void> {
    const requests = args.requests ?? 0;
    const tokens = args.tokens ?? 0;

    if (this.requestGate) {
      await this.requestGate.acquire(requests);
    }
    if (this.tokenGate) {
      await this.tokenGate.acquire(tokens);
    }
  }
}
