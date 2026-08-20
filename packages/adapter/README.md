# automation-adapter

**The only place in the platform that talks to GitHub.** Everything else decides; this asks and
answers. It sits on `core/` and on nothing else, and exactly one file outside it — the shell's
composition root — ever names it.

Its knowledge goes stale the way `core/src/github/`'s does: these files describe a live system that
is free to change underneath them, so green tests mean the code still agrees with what was measured,
not that it is correct. The build guide is
[`design/guides/adapter.md`](../../design/guides/adapter.md); the operation list and its costs are
[`design/findings/endpoint-permission-matrix.md`](../../design/findings/endpoint-permission-matrix.md).

## What is here today

| File | The question it answers |
|---|---|
| `jwt.ts` | What proves we are the App? |
| `token.ts` | What token may we call with, right now? |

Both are network-free. `jwt.ts` is a pure function of its credentials and a `now` handed to it;
`token.ts` takes the mint call as an injected function, so its whole lifecycle — cache, early
refresh, single flight — is driven by a fake clock in tests and no test reaches the network.

**Minting is injected rather than called** because that one request authenticates with the assertion
instead of with a token. It cannot travel through the HTTP client, since the client is what needs the
token this produces.

## The trap this package exists around

**An expired token and a wrong private key return byte-identical 401 bodies** (`"Bad credentials"`,
observed 2026-07-23). Nothing in the response distinguishes them, so `isPastExpiry` is the local fact
`classifyFailure` needs to tell an expiry apart from a credential fault. A token cache that only
reacted to 401s would classify every expiry as a bad key.

## Still to arrive

The HTTP client (ETags, timeouts, bounded retry, classification through core's `classifyFailure`),
the operations — one per confirmed matrix row — and the seam implementations the shell composes:
`githubConfigSource`, `liveExternals`, and the resolvers. `design/guides/adapter.md` holds the order
and what each one is blocked on.

## What keeps it honest

`pnpm --filter @hiero-hackers/automation-adapter test` typechecks and runs the suite. CI holds no
credential and neither does this package: every credential is untracked environment, supplied to the
composition root. Fixtures are built lazily inside tests, never at describe-time — an eagerly built
fixture turns a mutant that breaks signing into a collection crash, which vitest reports as "no
tests" and Stryker scores as survived (D89).
