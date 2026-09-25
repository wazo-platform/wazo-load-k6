# wazo-load-k6

[k6](https://grafana.com/docs/k6/latest/) load test scripts for the Wazo Platform:
SIP and RTP, browser-driven WebRTC, and mobile push wake-up.

## Usage

```sh
WAZO_ENGINE=engine.example.com \
WAZO_USERNAME=alice \
WAZO_PASSWORD=secret \
k6 run scripts/auth-token.js
```

Required:

| Variable                         | Meaning                      |
| -------------------------------- | ---------------------------- |
| `WAZO_ENGINE`                    | engine host                  |
| `WAZO_USERNAME`, `WAZO_PASSWORD` | user the token is minted for |

Optional:

| Variable   | Default | Meaning                |
| ---------- | ------- | ---------------------- |
| `VUS`      | `1`     | virtual users          |
| `DURATION` | `10s`   | how long the run lasts |

## Call load

`scripts/sip-call.js` dials a group or queue at `CALL_RATE` and answers with
`MEMBERS` registered accounts; each call streams audio for a talk time drawn
around `TALK_SECONDS`.

```sh
docker run --rm --network host \
  --env WAZO_ENGINE=engine.example.com \
  --env CALLER_USERNAME=loadtester --env CALLER_PASSWORD=loadtester \
  --env CALLEE_EXTEN=20000 \
  wazoplatform/wazo-load-k6 run /scripts/sip-call.js
```

By default: 30 calls a minute, one-minute talk time, 50 members, five
minutes.

Required:

| Variable                             | Meaning                     |
| ------------------------------------ | --------------------------- |
| `WAZO_ENGINE`                        | engine host                 |
| `CALLEE_EXTEN`                       | what the caller dials       |
| `CALLER_USERNAME`, `CALLER_PASSWORD` | the trunk placing the calls |

Optional:

| Variable             | Default              | Meaning                                    |
| -------------------- | -------------------- | ------------------------------------------ |
| `CALL_RATE`          | `0.5`                | calls per second, may be fractional        |
| `SIMULTANEOUS_CALLS` | derived              | concurrent calls, in place of `CALL_RATE`  |
| `TALK_SECONDS`       | `60`                 | mean talk time                             |
| `MEMBERS`            | `50`                 | members registered to answer               |
| `MEMBER_BASE`        | `10000`              | first member account                       |
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
- **The destination caps concurrency**: the `callees` group allows 1000
  calls, a queue has its own limit.
- **One process holds about a thousand concurrent calls.** Pass
  `--ulimit nofile=65536` past a few hundred members. Members listen from
  port `5070` and the deployment opens up to `15069`, so a process tops out
  at 10000 members.
- **A run outlasts `RUN_SECONDS`**: members stay until the last call hangs
  up, at most ten times `TALK_SECONDS` later. Keep `RUN_SECONDS` well above
  `TALK_SECONDS`.

## Docker image

The SIP and RTP scripts need a k6 binary built with the
[xk6-sip-media](https://github.com/srthorat/xk6-sip-media) extension, which the
image provides on top of the official browser-enabled k6 image. Each push
publishes it to [Docker Hub](https://hub.docker.com/r/wazoplatform/wazo-load-k6)
as `wazoplatform/wazo-load-k6:latest`, for amd64 and arm64:

```sh
docker run --rm wazoplatform/wazo-load-k6 run /scripts/auth-token.js
```

To build it yourself:

```sh
docker build -t wazo-load-k6 .
docker run --rm wazo-load-k6 run /scripts/auth-token.js
```

`scripts/` is baked into the image at `/scripts`. Mount over it to run a
script that is not in the image yet:

```sh
docker run --rm -v "$PWD/scripts:/scripts" wazo-load-k6 run /scripts/auth-token.js
```

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
script and lives outside `scripts/`.

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
