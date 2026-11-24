import type { Catalog } from "./catalog.js";
import { BodyTooLarge, bodyOf, Outlet, pairsOf } from "./outlet.js";
import { passThrough, type Undecoded } from "./pass-through.js";
import type { Anthropic, Body, Enums, LimitsAnswer, LogLine, Routing } from "./services.js";
import type { ProxySettings } from "./settings.js";
import { walk, type Walked } from "./walk.js";

export interface Proxy {
  readonly routing: Routing;
  readonly anthropic: Anthropic;
  readonly enums: Enums;
  readonly settings: ProxySettings;
  readonly limits: LimitsAnswer;
  readonly catalog: Catalog;
  readonly writeLog: (lines: readonly LogLine[]) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function written(outlet: Outlet, body: Body): void {
  outlet.whole(body.status, body.headers, body.bytes);
}

/** An error reply: the status is the deciding answer's, the body and its headers `error_envelope`'s. */
async function envelope(proxy: Proxy, outlet: Outlet, status: number, replyKind: number, message: string): Promise<void> {
  const body = await proxy.anthropic.error_envelope({ argument: { reply_kind: replyKind, message } });
  outlet.whole(status, body.headers, body.bytes);
}

/** The model id a lookup names, or the raw id when its escapes are malformed, which C then answers as unknown. */
function modelIdOf(lookup: string): string {
  try {
    return decodeURIComponent(lookup);
  } catch (error) {
    if (error instanceof URIError) return lookup;
    throw error;
  }
}

async function models(proxy: Proxy, outlet: Outlet, lookup: string | undefined): Promise<void> {
  const { entries } = await proxy.catalog.current();
  if (lookup === undefined) written(outlet, await proxy.anthropic.model_listing({ argument: { models: entries } }));
  else written(outlet, await proxy.anthropic.model_lookup({ argument: { models: entries, id: modelIdOf(lookup) } }));
}

/** The request as the walk takes it, or undefined once C's decode answered a reply of its own. */
async function decoded(proxy: Proxy, request: Request, body: Uint8Array, outlet: Outlet): Promise<Walked | undefined> {
  const answer = await proxy.anthropic.decode_request({ argument: { bytes: body, headers: pairsOf(request.headers) } });
  if (answer.request === undefined) {
    await envelope(proxy, outlet, answer.status, answer.reply_kind, answer.message!);
    return undefined;
  }
  return { ir: answer.request, headers: answer.forwarded_headers, model: answer.request.model, passThrough: false };
}

function pathOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

async function routed(proxy: Proxy, request: Request, outlet: Outlet): Promise<void> {
  const path = pathOf(request);
  const route = await proxy.anthropic.route_request({ argument: { method: request.method, path } });
  if (route.kind === proxy.enums.anthropic.forebay_anthropic_route_kind.FOREBAY_ANTHROPIC_ROUTE_MODEL_LIST || route.kind === proxy.enums.anthropic.forebay_anthropic_route_kind.FOREBAY_ANTHROPIC_ROUTE_MODEL_LOOKUP) {
    await models(proxy, outlet, route.kind === proxy.enums.anthropic.forebay_anthropic_route_kind.FOREBAY_ANTHROPIC_ROUTE_MODEL_LOOKUP ? route.model_id! : undefined);
    return;
  }
  const body = await bodyOf(request, proxy.limits.max_request_bytes);
  const walked = route.kind === proxy.enums.anthropic.forebay_anthropic_route_kind.FOREBAY_ANTHROPIC_ROUTE_MESSAGES ? await decoded(proxy, request, body, outlet) : { headers: pairsOf(request.headers), model: null, passThrough: true };
  if (walked === undefined) return;
  const { upstream, placeholderAuthorization } = proxy.settings;
  const through = { routing: proxy.routing, enums: proxy.enums.routing, anthropic: proxy.anthropic, upstream, placeholderAuthorization, keyHeaders: route.key_headers ?? [], writeLog: proxy.writeLog };
  const undecoded: Undecoded = { method: request.method, url: path, headers: request.headers, body };
  const walker = { routing: proxy.routing, anthropic: proxy.anthropic, enums: proxy.enums, settings: proxy.settings, catalog: proxy.catalog, writeLog: proxy.writeLog, passThrough: () => passThrough(through, undecoded, outlet) };
  await walk(walker, walked, outlet);
}

async function tooLarge(proxy: Proxy, outlet: Outlet): Promise<void> {
  const { too_large_status, too_large_reply_kind, too_large_message } = proxy.limits;
  await envelope(proxy, outlet, too_large_status, too_large_reply_kind, too_large_message);
}

async function failed(proxy: Proxy, outlet: Outlet, error: unknown): Promise<void> {
  const failure = await proxy.routing.failure({ argument: { reason: proxy.enums.routing.forebay_failure_reason.FOREBAY_REQUEST_FAILED, detail: messageOf(error) } });
  proxy.writeLog(failure.log);
  await envelope(proxy, outlet, failure.status, failure.reply_kind, failure.message);
}

/**
 * Answers one request OpenCode's model client sends, asking C at every turn: the route, the decode and each step.
 * @implNote No arrival is asked: the request never crossed a socket, so there is no listener for C to guard.
 */
async function served(proxy: Proxy, request: Request, outlet: Outlet): Promise<void> {
  try {
    await routed(proxy, request, outlet);
  } catch (error) {
    if (outlet.signal.aborted) return;
    const answered = error instanceof BodyTooLarge ? tooLarge(proxy, outlet) : failed(proxy, outlet, error);
    await answered.catch(() => outlet.destroy());
  }
}

/** The `fetch` OpenCode's model client sends every request through, answering each in this process. */
export function proxyFetch(proxy: Proxy): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const request = new Request(input, init);
    const outlet = new Outlet(request.signal);
    void served(proxy, request, outlet).finally(() => {
      if (!outlet.headersSent) outlet.destroy();
    });
    return outlet.response;
  };
}
