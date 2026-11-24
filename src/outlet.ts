import type { Pair } from "./services.js";

/** The body did not fit under the limit C set. */
export class BodyTooLarge extends Error {}

export function pairsOf(headers: Headers): Pair[] {
  return [...headers].map(([name, value]) => ({ name, value }));
}

export function headersOf(pairs: readonly Pair[]): Headers {
  const headers = new Headers();
  for (const pair of pairs) headers.set(pair.name, pair.value);
  return headers;
}

/** The whole body of `request`, refused with BodyTooLarge as soon as it is known to pass `maxBytes`. */
export async function bodyOf(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new BodyTooLarge();
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("the request was aborted", "AbortError");
}

/**
 * The Response one in-process request answers: settled with a whole body, or with a stream whose bytes follow, and
 * `signal` aborted once the caller went away, by its own signal or by cancelling the stream.
 */
export class Outlet {
  readonly response: Promise<Response>;
  readonly signal: AbortSignal;
  readonly #gone = new AbortController();
  #resolve!: (response: Response) => void;
  #reject!: (reason: unknown) => void;
  #settled = false;
  #stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  #ended = false;
  #pulled: (() => void) | undefined;

  constructor(callerSignal: AbortSignal | null) {
    this.signal = this.#gone.signal;
    this.response = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.signal.addEventListener("abort", () => this.#abandoned(), { once: true });
    if (callerSignal?.aborted) this.#gone.abort(abortReason(callerSignal));
    else callerSignal?.addEventListener("abort", () => this.#gone.abort(abortReason(callerSignal)), { once: true });
  }

  get headersSent(): boolean {
    return this.#settled;
  }

  /** Answers a whole reply with the status and headers C answered; a reply after bytes already went out fails the stream. */
  whole(status: number, headers: readonly Pair[], bytes: Uint8Array | string | null): void {
    if (this.#settled) {
      this.destroy();
      return;
    }
    this.#settle(new Response(bytes, { status, headers: headersOf(headers) }));
  }

  /** Answers the status and headers of a reply whose body follows through `write` and `end`. */
  head(status: number, headers: readonly Pair[]): void {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stream = controller;
      },
      pull: () => {
        this.#pulled?.();
        this.#pulled = undefined;
      },
      cancel: (reason) => this.#gone.abort(reason),
    });
    this.#settle(new Response(body, { status, headers: headersOf(headers) }));
  }

  /** Queues `bytes`, answering once the reader wants more or went away. */
  async write(bytes: Uint8Array): Promise<void> {
    if (this.#stream === undefined || this.#ended || this.signal.aborted) return;
    this.#stream.enqueue(bytes);
    if ((this.#stream.desiredSize ?? 1) > 0) return;
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        this.signal.removeEventListener("abort", settle);
        resolve();
      };
      this.#pulled = settle;
      this.signal.addEventListener("abort", settle, { once: true });
    });
  }

  end(): void {
    if (this.#stream === undefined || this.#ended) return;
    this.#ended = true;
    if (!this.signal.aborted) this.#stream.close();
  }

  /** Fails the reply: before its head the Response itself, after it the stream its reader reads. */
  destroy(): void {
    const failure = new Error("the proxy could not finish its reply");
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(failure);
      return;
    }
    if (this.#stream !== undefined && !this.#ended) {
      this.#ended = true;
      if (!this.signal.aborted) this.#stream.error(failure);
    }
  }

  #settle(response: Response): void {
    this.#settled = true;
    this.#resolve(response);
  }

  #abandoned(): void {
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(abortReason(this.signal));
    } else if (this.#stream !== undefined && !this.#ended) {
      this.#ended = true;
      this.#stream.error(abortReason(this.signal));
    }
    this.#pulled?.();
    this.#pulled = undefined;
  }
}
