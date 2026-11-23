import { FAILURE_REASON } from "./kinds.js";
import { headersOf, pairsOf, type Outlet } from "./outlet.js";
import type { Anthropic, LogLine, Routing } from "./services.js";

export interface PassThrough {
  readonly routing: Routing;
  readonly anthropic: Anthropic;
  readonly upstream: unknown;
  readonly placeholderAuthorization: unknown;
  readonly writeLog: (lines: readonly LogLine[]) => void;
}

/** The request as it goes upstream: its method, path with query, headers and the body already read. */
export interface Undecoded {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

type Sent = { readonly answer: Response } | { readonly error: Error };

/** @implNote A body is sent only for a method that may carry one, as `fetch` refuses one for GET and HEAD. */
async function sent(target: string, request: Undecoded, headers: Headers, signal: AbortSignal): Promise<Sent> {
  const carriesBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    const answer = await fetch(target, { method: request.method, headers, body: carriesBody ? request.body : undefined, signal, redirect: "manual" });
    return { answer };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function unreachable(through: PassThrough, outlet: Outlet, error: Error): Promise<void> {
  const failure = await through.routing.failure({ argument: { reason: FAILURE_REASON.UPSTREAM_UNREACHABLE, upstream: through.upstream, detail: error.message } });
  through.writeLog(failure.log);
  const body = await through.anthropic.error_envelope({ argument: { reply_kind: failure.reply_kind, message: failure.message } });
  outlet.whole(failure.status, body.headers, body.bytes);
}

async function relayed(body: ReadableStream<Uint8Array>, outlet: Outlet): Promise<void> {
  const reader = body.getReader();
  try {
    while (!outlet.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      await outlet.write(value);
    }
    outlet.end();
  } catch {
    outlet.destroy();
  } finally {
    if (outlet.signal.aborted) await reader.cancel().catch(() => undefined);
  }
}

/** Sends the request upstream undecoded, to the target and with the headers C answers, and its answer back as it came. */
export async function passThrough(through: PassThrough, request: Undecoded, outlet: Outlet): Promise<void> {
  const argument = { upstream: through.upstream, url: request.url, headers: pairsOf(request.headers), body_length: request.body.length, placeholder_authorization: through.placeholderAuthorization };
  const routed = await through.routing.pass_through({ argument });
  const answered = await sent(routed.target, request, headersOf(routed.headers), outlet.signal);
  if (outlet.signal.aborted) return;
  if ("error" in answered) {
    await unreachable(through, outlet, answered.error);
    return;
  }
  const { answer } = answered;
  const replied = await through.routing.reply_headers({ argument: { headers: pairsOf(answer.headers), rewritten: 0 } });
  if (answer.body === null) {
    outlet.whole(answer.status, replied.headers, null);
    return;
  }
  outlet.head(answer.status, replied.headers);
  await relayed(answer.body, outlet);
}
