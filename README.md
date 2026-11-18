# wazo-load-k6

[k6](https://grafana.com/docs/k6/latest/) load test scripts for the Wazo Platform:
SIP and RTP, browser-driven WebRTC, and mobile push wake-up.

## Usage

```sh
WAZO_ENGINE=engine.example.com \
WAZO_ADMIN_USERNAME=root \
WAZO_ADMIN_PASSWORD=secret \
k6 run scripts/on-demand/auth-token.js
```

Required:

| Variable                                     | Meaning                        |
| -------------------------------------------- | ------------------------------ |
| `WAZO_ENGINE`                                | engine host                    |
| `WAZO_ADMIN_USERNAME`, `WAZO_ADMIN_PASSWORD` | admin the token is created for |

Optional:

| Variable   | Default | Meaning                |
| ---------- | ------- | ---------------------- |
| `VUS`      | `1`     | virtual users          |
| `DURATION` | `10s`   | how long the run lasts |

## Call load

`scripts/on-demand/sip-call.js` dials a queue at `CALL_RATE` and answers
with `MEMBERS` registered accounts; each call streams audio for a talk time
drawn around `TALK_SECONDS`.

```sh
docker run --rm --network host \
  --env WAZO_ENGINE=engine.example.com \
  --env CALLER_USERNAME=loadtester --env CALLER_PASSWORD=loadtester \
  --env CALLEE_EXTEN=30000 \
  --env WAZO_ADMIN_USERNAME=root --env WAZO_ADMIN_PASSWORD=secret \
  wazoplatform/wazo-load-k6 run /scripts/on-demand/sip-call.js
```

By default: 30 calls a minute, one-minute talk time, 50 members, five
minutes.

`CALLEE_EXTEN` must reach a queue whose agents are numbered after the
members' extensions (`MEMBER_BASE` and up): the run logs in the members'
agents at start and logs them off at the end. The queue only rings
logged-in agents whose line is registered, so the calls go to this run's
members alone.

Required:

| Variable                                     | Meaning                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `WAZO_ENGINE`                                | engine host                                          |
| `CALLEE_EXTEN`                               | the queue the caller dials                           |
| `CALLER_USERNAME`, `CALLER_PASSWORD`         | the trunk placing the calls                          |
| `WAZO_ADMIN_USERNAME`, `WAZO_ADMIN_PASSWORD` | admin with `confd.extensions.read` and agentd logins |

Optional:

| Variable             | Default              | Meaning                                    |
| -------------------- | -------------------- | ------------------------------------------ |
| `CALL_RATE`          | `0.5`                | calls per second, may be fractional        |
| `SIMULTANEOUS_CALLS` | derived              | concurrent calls, in place of `CALL_RATE`  |
| `TALK_SECONDS`       | `60`                 | mean talk time                             |
| `MEMBERS`            | `50`                 | members registered to answer               |
| `MEMBER_BASE`        | `10000`              | first member account                       |
| `LISTEN_PORT_BASE`   | `5070`               | first member listen port                   |
| `RUN_SECONDS`        | `300`                | how long calls are offered                 |
| `AUDIO_FILE`         | `/audio/tone-3s.wav` | what both ends stream                      |
| `SIP_LOCAL_IP`       | auto-detected        | address advertised in Via, Contact and SDP |

The example values match what
[wazo-load-tools](https://github.com/wazo-platform/wazo-load-tools)
provisions; each member uses its account number as SIP username and secret.
Set `SIP_LOCAL_IP` over a VPN: auto-detection picks the
default-route address, which the engine cannot answer back on.

### Rate, talk time and concurrency are one relation

`concurrent calls = CALL_RATE × TALK_SECONDS`. `CALL_RATE` and
`SIMULTANEOUS_CALLS` are two ways of saying the same thing, so give one or
the other and the script derives the rest — passing both is an error. It
sizes its VU allocation from the result and prints all three at startup.
Talk times are drawn from an exponential distribution around the mean,
capped just under ten times it, so the calls in progress vary around that
figure rather than sitting on it.

k6 takes a whole number of calls per time unit, so a fractional `CALL_RATE`
is offered per minute: `CALL_RATE=0.2` runs as 12 calls a minute, which is
what the startup line reports.

### What bounds a run

- **`MEMBERS` must carry the peak.** A member on a call is not rung again,
  so the script refuses to start below the mean concurrency, and a pool
  sized only for the mean rejects the peaks.
- **Agents must exist for every member**: a member whose agent is missing
  fails the run at login.
- **One process holds about a thousand concurrent calls.** Pass
  `--ulimit nofile=65536` past a few hundred members.
- **Members listen on `LISTEN_PORT_BASE` and the `MEMBERS - 1` ports
  above**, printed at startup: the network in front of the generator must
  let the engine reach them, or calls go unanswered.
- **A run outlasts `RUN_SECONDS`**: members stay until the last call hangs
  up, at most ten times `TALK_SECONDS` later. Keep `RUN_SECONDS` well above
  `TALK_SECONDS`.

### Continuous call load

`scripts/continuous/sip-call.js` places the same calls, with the same
variables except `RUN_SECONDS`, until the run is stopped (`docker stop`,
Ctrl-C). Stopping hangs up the calls in progress and logs the agents off,
so none is left up on the stack. It has no thresholds and no monitor
checks: the dashboards follow it.

Members listen on host ports, so runs sharing a host need
`LISTEN_PORT_BASE` ranges that do not overlap.

## Bus bindings load

`scripts/on-demand/bus-bindings.js` loads RabbitMQ with the bindings mobile
users bring: each user registers a push token, for which wazo-webhookd binds
the user's push events, and holds a websocket subscribed one event at a
time to the events the mobile app subscribes to
(`assets/mobile-websocket-events.json`), for which wazo-websocketd binds
each event. After `SETTLE_SECONDS`, for the stack to process the push token
registrations, sessions open in `RAMP_STEPS` equal steps, `STEP_SECONDS`
apart, then hold `HOLD_SECONDS`.

It reports, per number of sessions open (`sessions` tag):

- `ws_subscribe_duration`: from the session's first subscribe to the
  acknowledgement of its start, all its bindings created
- `bus_event_latency`: the first `PROBE_SESSIONS` sessions re-send their
  push token every `PROBE_INTERVAL_SECONDS`, as the app does on refresh, and
  time the update event wazo-auth sends back through the bus; the probe rate
  stays the same while the other sessions open
- `bus_event_lost`: probe events still missing when the next probe goes

The session also subscribes to that update event, which the app does not.

A session opens as the app does: it replays the REST requests the app sends
when it logs in (`assets/mobile-login.json`), at their recorded times, and
opens the websocket when the app did. Each request carries the user's own
identifiers, taken from its token or from the responses before it: its line,
its directory sources, the people in its call history and its contacts.
`mobile_login_skipped` counts the requests the stack has no value for, such as
a directory backend it does not configure. Requests are reported by route
(`name` tag). With `CREATE_USERS`, whose users exist only in wazo-auth, the
session opens its websocket straight away.

```sh
docker run --rm --network host \
  --env WAZO_ENGINE=engine.example.com \
  --env WAZO_ADMIN_USERNAME=root --env WAZO_ADMIN_PASSWORD=secret \
  wazoplatform/wazo-load-k6 run /scripts/on-demand/bus-bindings.js
```

By default it logs in the users
[wazo-load-tools](https://github.com/wazo-platform/wazo-load-tools)
provisions. On a stack without them, `CREATE_USERS=true` creates its users in
`WAZO_TENANT` and deletes them at the end, along with those a stopped run
left. Either way the push tokens are deleted at the end, so the stack is
left with the bindings it had.

Required:

| Variable                                     | Meaning                                   |
| -------------------------------------------- | ----------------------------------------- |
| `WAZO_ENGINE`                                | engine host                               |
| `WAZO_ADMIN_USERNAME`, `WAZO_ADMIN_PASSWORD` | admin deleting the push tokens, and users |
| `WAZO_TENANT`                                | tenant of the users, with `CREATE_USERS`  |

Optional:

| Variable                 | Default               | Meaning                                    |
| ------------------------ | --------------------- | ------------------------------------------ |
| `USERS`                  | `5000`                | users registering a push token             |
| `SESSIONS`               | `USERS`               | those of them holding a websocket          |
| `USERNAME_TEMPLATE`      | `dev+user{i}@wazo.io` | existing users, `{i}` from 0               |
| `USER_PASSWORD`          | `secret`              | their password, or the created users' one  |
| `CREATE_USERS`           | `false`               | `true` to create `load-bindings-{i}` users |
| `SETTLE_SECONDS`         | `60`                  | wait before the first sessions open        |
| `RAMP_STEPS`             | `10`                  | steps opening the sessions                 |
| `STEP_SECONDS`           | `60`                  | time between steps                         |
| `HOLD_SECONDS`           | `120`                 | time with every session open               |
| `SESSIONS_PER_VU`        | `50`                  | sessions each k6 VU holds                  |
| `PROBE_SESSIONS`         | `100`                 | first sessions probing                     |
| `PROBE_INTERVAL_SECONDS` | `10`                  | time between a session's probes            |

## Mobile traffic profile

`tools/har-profile.mjs` reads a HAR capture of the mobile app, with its
websocket frames (`_webSocketMessages`, as mitmproxy and Chrome write them),
and counts each kind of message: REST calls by route, wazo-websocketd ops
and events, SIP over websocket by method and status.

```sh
node tools/har-profile.mjs --host engine.example.com profile app.har
node tools/har-profile.mjs --host engine.example.com diff old.har new.har
node tools/har-profile.mjs subscriptions app.har > assets/mobile-websocket-events.json
```

`diff` prints, as a Markdown table, what an app version sends or receives
differently from the previous one: a new subscription, a new polled route.
`subscriptions` refreshes the events `bus-bindings.js` subscribes to.
`--host` drops what the OS and other apps send during the capture.

`tools/har-login.mjs` extracts the requests a session sends when it logs in,
which `bus-bindings.js` replays:

```sh
node tools/har-login.mjs --host engine.example.com app.har > assets/mobile-login.json
```

It replaces every identifier with a placeholder naming where the replay takes
it from. It stops on a value it cannot trace back to the token or to an
earlier response: the app has started to depend on something the replay does
not know how to fill yet.

## Benchmarks

Short benchmarks, a script each, that fail the run when slower than their
thresholds. They measure against the users already on the stack and create
what else they need in `WAZO_TENANT` as the admin, cleaning nothing up: run
them on a fresh stack, since a second run fails on what the first created.

```sh
docker run --rm \
  --env WAZO_ENGINE=engine.example.com \
  --env WAZO_ADMIN_USERNAME=root --env WAZO_ADMIN_PASSWORD=secret \
  --env WAZO_TENANT=9d283e05-6b2f-46b4-bca5-1c2558dbcb53 \
  wazoplatform/wazo-load-k6 run /scripts/daily/90-confd-users-import.js
```

Required by every benchmark:

| Variable                                     | Meaning                                  |
| -------------------------------------------- | ---------------------------------------- |
| `WAZO_ENGINE`                                | engine host                              |
| `WAZO_ADMIN_USERNAME`, `WAZO_ADMIN_PASSWORD` | admin with the ACLs listed per benchmark |
| `WAZO_TENANT`                                | UUID of the tenant benchmarked           |

- **`90-confd-users-import.js`** imports 100 users from `assets/100entries.csv`,
  into contexts it creates for their extensions (6000-6099). Needs
  `confd.contexts.create` and `confd.users.import.create`.
- **`10-dird-personal-import.js`** imports 1000 personal contacts from
  `assets/1000contacts.csv`, as a user it creates in wazo-auth. Needs
  `auth.users.create`.
- **`10-dird-lookups.js`** looks up the stack users by last name, then reverse
  looks up their extensions once the lookups are over, after a few warm-up
  requests. Needs `confd.users.read`, `dird.directories.lookup.#` and
  `dird.directories.reverse.#`.

## Monitor checks

Thresholds judge what the generator sees. What only the monitoring shows is
checked at the end of each script: `teardown()` queries the Prometheus that
scrapes the stack over the script's own run, from the start of `setup()`,
and a failed check fails the `monitor_checks` threshold. The checks first
wait for every exporter of the stack to be scraped after the run, and fail
when one is down.

- **`modules/monitor-checks/stack-invariants.js`** holds what must hold on
  any run, so every script calls it: no service or process restarted, no
  OOM kill, server errors within bounds, no RabbitMQ queue losing its
  consumers.
- A check that only makes sense for one scenario lives in its script, which
  calls `checkMonitor()` from `modules/monitor-checks/check.js`, as
  `sip-call.js` does for the stack's latency per service.

`MONITOR_CHECKS_PROMETHEUS_URL` points at that Prometheus; unset, the checks
are skipped. Set, the run needs a `testid` tag (`k6 run --tag testid=<id>`), which the
stack's series must carry as a `testid` label: the checks select the stack
by it. Only a stack created for the run carries it, so a permanent stack
cannot be checked.

## Docker image

The SIP and RTP scripts need a k6 binary built with the
[xk6-sip-media](https://github.com/srthorat/xk6-sip-media) extension, which the
image provides on top of the official browser-enabled k6 image. Each push
publishes it to [Docker Hub](https://hub.docker.com/r/wazoplatform/wazo-load-k6)
as `wazoplatform/wazo-load-k6:latest`, for amd64 and arm64:

```sh
docker run --rm wazoplatform/wazo-load-k6 run /scripts/on-demand/auth-token.js
```

To build it yourself:

```sh
docker build -t wazo-load-k6 .
docker run --rm wazo-load-k6 run /scripts/on-demand/auth-token.js
```

`scripts/` is baked into the image at `/scripts`. Mount over it to run a
script that is not in the image yet:

```sh
docker run --rm -v "$PWD/scripts:/scripts" wazo-load-k6 run /scripts/on-demand/auth-token.js
```

`modules/` and `assets/`, which the scripts import and read, are baked in at
`/modules` and `/assets` the same way.

`K6_VERSION` and `XK6_SIP_MEDIA_VERSION` build args pin what goes in.

`patches/` holds the fixes applied to the extension before building. Each one
is a `git format-patch` export of a single commit, to submit upstream as-is and
to delete here once merged.

## Conventions

Naming and structure follow the
[k6 glossary](https://grafana.com/docs/k6/latest/reference/glossary/):

- a **test script** is a file in `scripts/`, runnable with `k6 run`
- a **scenario** is an entry of
  [`options.scenarios`](https://grafana.com/docs/k6/latest/using-k6/scenarios/)
  inside a script, never a file on its own
- a **test run** is one execution of a script

Everything in `scripts/` is runnable; shared code is a module imported by a
script and lives in `modules/`. Data files a script reads, such as CSV
imports, live in `assets/`.

The directory a script sits in says when it runs:

| Directory     | Runs                                    |
| ------------- | --------------------------------------- |
| `daily/`      | every night, on a fresh stack           |
| `weekly/`     | every week, on a fresh stack            |
| `continuous/` | without end, against a long-lived stack |
| `on-demand/`  | only when started by hand               |

A `continuous/` script never ends, so it has no thresholds: the monitoring
is what flags it.

Scripts take their parameters from
[environment variables](https://grafana.com/docs/k6/latest/using-k6/environment-variables/),
read through `__ENV` and passed with `k6 run -e NAME=value` or
`docker run --env NAME=value` — k6 hands a script no arguments of its own. A
parameter either has a default or makes the script throw when it is missing.
Names stay unprefixed: a `K6_`-prefixed variable configures k6 itself and
overrides the script, so `K6_VUS` bypasses `VUS` rather than feeding it.

## Lint

The repository is checked with [ESLint](https://eslint.org/docs/latest/) and
[Prettier](https://prettier.io/docs/), run through
[pre-commit](https://pre-commit.com/), locally and by Zuul on every change:

```sh
tox -e linters
```

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
