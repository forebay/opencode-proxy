The proxy OpenCode talks to, inside OpenCode's own process. It is a weivel plugin that registers one service for
OpenCode's plugin API and asks forebay-library's C for every decision: what a request is, how its body reads, which
provider serves it, what to do when one fails and how each reply is written. The plugin holds only the I/O and the
order of the calls. It opens no socket, stores no credential and writes no OpenCode file.

It reaches C only through its host: it consumes the `routing` and `anthropic` services and the `forebay.provider`
capability by id through its context, and reads its settings and writes its log through `weivel.config` and
`weivel.log`. It never loads a library itself.

## How OpenCode reaches it

An in-process entry in OpenCode's plugin folder imports weivel/typescript's in-process bundle
(`weivel-host-in-process.mjs`, with the pinned `node_modules/koffi` beside it), calls `startHost` over `runtime` with
`<loader id> in-process`, a run that serves its own process and never claims the loader, so every OpenCode process
hosts its own, asks
the running host for the service `opencode-proxy:opencode-plugin` and returns what it answers to OpenCode. The service
is a function from OpenCode's plugin input to its hooks. The entry names a service id, never proxy code.

The `config` hook adds `config.provider.<providerId>` with `npm: "@ai-sdk/anthropic"`, the catalog's model entries
with their context and output limits, `options.apiKey` the placeholder authorization (the model client refuses to run
without a key), and `options.fetch`, through which OpenCode's model client sends every request to this process. No
config file is edited and `auth.json` is never written.

## Structure

- `src/plugin.ts`: activation; opens the catalog and registers `opencode-proxy:opencode-plugin`.
- `src/hooks.ts`: the `config` hook, copying C's model entries into OpenCode's provider entry.
- `src/fetch.ts`: one request: `anthropic.route_request`; the model routes are answered from the catalog's entries
  and `anthropic.model_listing` or `model_lookup`, a messages body is decoded by `anthropic.decode_request`, and every
  other request is walked as a pass-through. No arrival is asked, since no request crossed a socket.
- `src/walk.ts`: the loop, `routing.step` until it answers done, performing each step and reporting how it went;
  exhaustion is answered by `anthropic.rate_limit_reply`, never by the upstream's own 429. Each provider call carries
  a random token, and the provider's `cancel` is called with it when OpenCode cancels the request before `handle`
  answered.
- `src/relay.ts`: a provider's stream through `anthropic.stream_encode`, one encoder per provider, and the error event
  C names when it fails after bytes went out; the stream is freed through the provider's `release_stream` when it
  offers one, OpenCode cancelling the request included.
- `src/outlet.ts`: the Response a request answers, whole or streamed, and the caller going away.
- `src/pass-through.ts`: `routing.pass_through` and `reply_headers`, the answer reported rewritten since `fetch`
  decodes a compressed body itself, and `routing.failure` for an unreachable upstream.
- `src/catalog.ts`: the providers' models, kept by forebay-library's catalog object; it performs the asks and sets the
  timers C names and parks each request on the round C names.
- `src/settings.ts`: each setting whole through `weivel.config`'s `get_tree`, and the settings file C names to the
  user from its `settings_file`.
- `src/zone.ts`: the machine's zone offset and its en-US and en-GB short names at an instant, from `Intl`; C chooses
  the name a reset is given in.

## Configuration

`plugin.json`'s `config.defaults` hold `upstream`, the placeholder authorization OpenCode's model client is given as
its key, OpenCode's provider id, name and base URL, and the routing profile under `routing`: no tier pattern, so every
provider's models are listed directly, the default limits and the login command the no-model reply names. A stored
model map goes under `routing.modelMap`, each slot a list of `{provider, model}`.

## Testing

`npm test` builds forebay-library's `forebay_library` and spisor/library's `runtime` with CMake into `native/`
(`scripts/native.ts`), builds and type-checks, and runs vitest.

- `test/hooks.test.ts` lays out a temporary home with the four `SPISOR_*` places under it, installs the proxy and the
  test provider of `test/fixtures/provider/` into it, runs `runtime` under weivel/typescript's `startHost` in process,
  and calls the service's hooks and fetch directly.
- `test/opencode.test.ts` installs the OpenCode version `test/opencode-version.json` names into a temporary
  directory, writes the in-process entry into an isolated OpenCode home, and runs `opencode models` and
  `opencode run` against the test provider, one OpenCode after another and two at once, asserting no JavaScript
  listen after the entry loaded, the pinned koffi loaded, no `auth.json` or OpenCode config file, and no change under
  the real home's OpenCode, Bun and npm folders.
- The OpenCode cases need the network: npm installs `opencode-ai`, and OpenCode installs its own
  `@opencode-ai/plugin` and fetches its models.dev catalog on start.

The siblings are pinned in `repo.json` under `siblings/`, each nested one at the path its parent's build reads:
`typescript` with its `core`, `standard` and `conformance`, `forebay-library` with its `library`, `core`, `standard`
and `c`, and `library` with its `core`, `standard` and `c`. `siblings/typescript` is installed and built first
(`npm ci` and `npm run build` there), which needs CMake and a C compiler as the two native builds here do.
