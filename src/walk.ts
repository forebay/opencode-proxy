import type { Catalog, Snapshot } from "./catalog.js";
import { Relay } from "./relay.js";
import type { Anthropic, Enums, Handle, LogLine, Pair, Provider, ProviderHandleAnswer, Report, Routing, StepAnswer, StepArgument } from "./services.js";
import type { ProxySettings } from "./settings.js";
import type { Outlet } from "./outlet.js";
import { zoneAt } from "./zone.js";

export interface Walker {
  readonly routing: Routing;
  readonly anthropic: Anthropic;
  readonly enums: Enums;
  readonly settings: ProxySettings;
  readonly catalog: Catalog;
  readonly writeLog: (lines: readonly LogLine[]) => void;
  readonly passThrough: () => Promise<void>;
}

export interface Walked {
  readonly ir?: Record<string, unknown>;
  readonly headers: readonly Pair[];
  readonly model: string | null;
  readonly passThrough: boolean;
}

interface Exchange {
  readonly walker: Walker;
  readonly request: Walked;
  readonly outlet: Outlet;
  readonly relay: Relay;
  snapshot: Snapshot;
  refreshed: boolean;
  failureBody?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function argumentOf(exchange: Exchange, walk?: Handle, report?: Report): StepArgument {
  const { settings } = exchange.walker;
  return {
    providers: exchange.snapshot.names,
    profile: settings.profile,
    slots: exchange.snapshot.slots,
    catalog: exchange.snapshot.catalog,
    model: exchange.request.model,
    pass_through: exchange.request.passThrough ? 1 : 0,
    refreshed: exchange.refreshed ? 1 : 0,
    login_command: settings.loginCommand,
    settings_file: settings.settingsFile,
    ...(walk === undefined ? {} : { walk }),
    ...(report === undefined ? {} : { report }),
  };
}

async function stepped(exchange: Exchange, walk?: Handle, report?: Report): Promise<StepAnswer> {
  const answer = await exchange.walker.routing.step({ argument: argumentOf(exchange, walk, report) });
  exchange.walker.writeLog(answer.log);
  return answer;
}

/** A token no other call to the provider carries, so a consumer can end this call alone. */
function drawnToken(): bigint {
  return crypto.getRandomValues(new BigUint64Array(1))[0]!;
}

/** Ends the provider's call that carried `token`. */
async function cancelled(provider: Provider, token: bigint): Promise<void> {
  try {
    await provider.cancel({ argument: { token } });
  } catch {
    // The answer of a call the client left is discarded either way.
  }
}

/** The provider's answer to the request, its call cancelled by its token as soon as the client goes. */
async function handled(exchange: Exchange, provider: Provider, model: string): Promise<ProviderHandleAnswer> {
  const { signal } = exchange.outlet;
  const token = drawnToken();
  const cancel = (): void => void cancelled(provider, token);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const pending = provider.handle({ argument: { request: { ...exchange.request.ir, model }, headers: exchange.request.headers, token } });
    if (signal.aborted) cancel();
    return await pending;
  } catch (error) {
    return { kind: exchange.walker.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN, message: messageOf(error) };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function failureReport(failure: NonNullable<ProviderHandleAnswer["failure"]>, enums: Enums): Report {
  const { status, headers, has_retry_after, retry_after_milliseconds } = failure;
  const given = Object.entries({ headers, has_retry_after, retry_after_milliseconds }).filter(([, value]) => value !== undefined);
  return { kind: enums.routing.forebay_report_kind.FOREBAY_REPORT_FAILURE, status, now: Date.now(), ...Object.fromEntries(given) };
}

/**
 * Calls the provider step named, one of the providers this walk handed `step`, and answers the report of how it went,
 * or undefined once the client went away.
 */
async function called(exchange: Exchange, answer: StepAnswer): Promise<Report | undefined> {
  const provider = exchange.snapshot.byName.get(answer.provider!)!;
  const served = await handled(exchange, provider, answer.model!);
  const { enums } = exchange.walker;
  if (served.kind === enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE) {
    const body = await exchange.walker.anthropic.encode_response({ argument: { response: served.response } });
    exchange.outlet.whole(body.status, body.headers, body.bytes);
    return { kind: enums.routing.forebay_report_kind.FOREBAY_REPORT_RESPONSE };
  }
  if (served.kind === enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE) {
    exchange.failureBody = served.failure!.body ?? "";
    return failureReport(served.failure!, enums);
  }
  if (served.kind === enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_STREAM) return exchange.relay.relayed(provider, served.stream);
  return { kind: enums.routing.forebay_report_kind.FOREBAY_REPORT_THROWN, message: served.message ?? null };
}

async function rateLimited(exchange: Exchange, answer: StepAnswer): Promise<void> {
  const now = Date.now();
  const reset = answer.has_reset_at === 1 ? answer.reset_at : now;
  const argument = { upstream_headers: answer.headers, has_reset_at: answer.has_reset_at, reset_at: answer.reset_at, now, ...zoneAt(reset) };
  const reply = await exchange.walker.anthropic.rate_limit_reply({ argument });
  exchange.outlet.whole(reply.status, reply.headers, reply.body);
}

async function replied(exchange: Exchange, answer: StepAnswer): Promise<void> {
  const { outlet } = exchange;
  if (answer.reply_kind === exchange.walker.enums.routing.forebay_reply_kind.FOREBAY_REPLY_RATE_LIMITED) return rateLimited(exchange, answer);
  if (answer.reply_kind === exchange.walker.enums.routing.forebay_reply_kind.FOREBAY_REPLY_PROVIDER_FAILURE) {
    outlet.whole(answer.status, answer.headers, exchange.failureBody!);
    return;
  }
  const body = await exchange.walker.anthropic.error_envelope({ argument: { reply_kind: answer.reply_kind, message: answer.message! } });
  outlet.whole(answer.status, body.headers, body.bytes);
}

/** Performs one step; answers the report it owes `step`, or undefined when the walk ends here. */
async function performed(exchange: Exchange, answer: StepAnswer): Promise<Report | undefined> {
  const step = exchange.walker.enums.routing.forebay_step_kind;
  switch (answer.kind) {
    case step.FOREBAY_STEP_PASS_THROUGH:
      await exchange.walker.passThrough();
      return undefined;
    case step.FOREBAY_STEP_CALL_PROVIDER:
      return called(exchange, answer);
    case step.FOREBAY_STEP_REPLY:
      await replied(exchange, answer);
      return undefined;
    case step.FOREBAY_STEP_END_STREAM:
      await exchange.relay.endWithError(answer.error_type, answer.message);
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Walks one request along the chain C answers, step by step, until C says it is done: every branch is C's, and this
 * holds only the calls, the I/O and their order.
 */
export async function walk(walker: Walker, request: Walked, outlet: Outlet): Promise<void> {
  const { signal } = outlet;
  const exchange: Exchange = { walker, request, outlet, relay: new Relay(walker.anthropic, walker.enums, outlet), snapshot: await walker.catalog.current(), refreshed: false };
  let answer = await stepped(exchange);
  try {
    while (answer.kind !== walker.enums.routing.forebay_step_kind.FOREBAY_STEP_DONE && !signal.aborted) {
      if (answer.kind === walker.enums.routing.forebay_step_kind.FOREBAY_STEP_REFRESH_MODELS) {
        exchange.snapshot = await walker.catalog.refreshed();
        exchange.refreshed = true;
        answer.walk?.release();
        answer = await stepped(exchange);
        continue;
      }
      const report = await performed(exchange, answer);
      if (report === undefined || answer.walk === undefined) break;
      const previous = answer;
      answer = await stepped(exchange, previous.walk, report);
      previous.walk?.release();
    }
  } finally {
    answer.walk?.release();
    exchange.relay.release();
  }
}
