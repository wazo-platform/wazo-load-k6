# wazo-load-k6

[k6](https://grafana.com/docs/k6/latest/) load test scripts for the Wazo Platform:
SIP and RTP, browser-driven WebRTC, and mobile push wake-up.

## Usage

### auth-token.js

Creates admin tokens in a loop.

```sh
WAZO_ENGINE=engine.example.com \
WAZO_ADMIN_USERNAME=root \
WAZO_ADMIN_PASSWORD=secret \
k6 run scripts/auth-token.js
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

### benchmarks.js

Short benchmarks, each a scenario that fails the run when it is slower than
its threshold:

- `confd-users-import`: imports 100 users through wazo-confd
- `dird-personal-import`: imports 1000 personal contacts through wazo-dird as
  the first imported user, once `confd-users-import` is over
- `dird-lookup` and `dird-reverse`: look up names and reverse look up numbers
  from the imported contacts and the users on the stack, as the first imported
  user, once `dird-personal-import` is over

It creates its own contexts for the users' extensions (6000-6099) and cleans
nothing up, so it expects a fresh stack: a second run fails on duplicate
extensions.

```sh
WAZO_ENGINE=engine.example.com \
WAZO_ADMIN_USERNAME=root \
WAZO_ADMIN_PASSWORD=secret \
WAZO_TENANT=9d283e05-6b2f-46b4-bca5-1c2558dbcb53 \
k6 run scripts/benchmarks.js
```

Required:

| Variable                                     | Meaning                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `WAZO_ENGINE`                                | engine host                                                                           |
| `WAZO_ADMIN_USERNAME`, `WAZO_ADMIN_PASSWORD` | user allowed `confd.contexts.create` and `confd.users.import.create` in `WAZO_TENANT` |
| `WAZO_TENANT`                                | UUID of the tenant the users are imported in                                          |

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

The data files the scripts read from `assets/` are baked in at `/assets` the
same way.

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
script and lives outside `scripts/`. Data files a script reads, such as CSV
imports, live in `assets/`.

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
