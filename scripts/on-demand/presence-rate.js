// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { clearInterval, setInterval, setTimeout } from "k6/timers";
import { WebSocket } from "k6/websockets";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
import { createToken, tokenRequest } from "../../modules/wazo.js";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
if (!engine || !adminUsername || !adminPassword) {
  throw new Error(
    "WAZO_ENGINE, WAZO_ADMIN_USERNAME and WAZO_ADMIN_PASSWORD are required",
  );
}

const sessions = Number(__ENV.SESSIONS || 1000);
const sessionsPerVu = Number(__ENV.SESSIONS_PER_VU || 50);
const senders = Number(__ENV.SENDERS || 20);
const rates = (__ENV.PRESENCE_RATES || "0,5,10,20,40").split(",").map(Number);
const stepSeconds = Number(__ENV.STEP_SECONDS || 120);
const settleSeconds = Number(__ENV.SETTLE_SECONDS || 60);
const openSeconds = Number(__ENV.OPEN_SECONDS || 30);
const usernameTemplate = __ENV.USERNAME_TEMPLATE || "dev+user{i}@wazo.io";
const userPassword = __ENV.USER_PASSWORD || "secret";
const probeSessions = Math.min(Number(__ENV.PROBE_SESSIONS || 50), sessions);
const probeIntervalSeconds = Number(__ENV.PROBE_INTERVAL_SECONDS || 10);
const timingSessions = Math.min(Number(__ENV.TIMING_SESSIONS || 10), sessions);
if (openSeconds >= settleSeconds) {
  throw new Error("OPEN_SECONDS must be below SETTLE_SECONDS");
}

const PROBE_EVENT = "auth_user_external_auth_updated";
const PRESENCE_EVENT = "chatd_presence_updated";
const STATUS_PREFIX = "load-presence-rate-";
const MOBILE_TOKEN_PREFIX = "load-presence-rate-";
const BATCH_SIZE = 50;
const FLUSH_SECONDS = 10;

const vus = Math.ceil(sessions / sessionsPerVu);
const stepStarts = rates.map((_, index) => settleSeconds + index * stepSeconds);
const runSeconds = settleSeconds + rates.length * stepSeconds;
const userTokenSeconds = runSeconds + 3600;

const auth = `https://${engine}/api/auth/0.1`;
const chatd = `https://${engine}/api/chatd/1.0`;

const eventLatency = new Trend("bus_event_latency", true);
const eventLost = new Counter("bus_event_lost");
const presenceLatency = new Trend("presence_event_latency", true);
const presenceReceived = new Counter("presence_events_received");
const presenceSent = new Counter("presence_sent");

function senderScenario(rate, index) {
  return {
    executor: "constant-arrival-rate",
    exec: "sendPresence",
    startTime: `${stepStarts[index]}s`,
    rate,
    timeUnit: "1s",
    duration: `${stepSeconds}s`,
    preAllocatedVUs: rate + 5,
    maxVUs: 2 * rate + 10,
  };
}

export const options = {
  insecureSkipTLSVerify: true,
  // url carries the user's token or uuid: a series per session otherwise
  systemTags: [
    "proto",
    "status",
    "method",
    "name",
    "check",
    "error",
    "error_code",
    "scenario",
    "expected_response",
  ],
  setupTimeout: "10m",
  teardownTimeout: "10m",
  scenarios: {
    sessions: {
      executor: "per-vu-iterations",
      exec: "holdSessions",
      vus,
      iterations: 1,
      maxDuration: `${runSeconds + 60}s`,
    },
    ...Object.fromEntries(
      rates
        .map((rate, index) => [`presence_${rate}`, rate, index])
        .filter(([, rate]) => rate > 0)
        .map(([name, rate, index]) => [name, senderScenario(rate, index)]),
    ),
  },
  thresholds: {
    // An empty metric passes every other threshold
    "http_reqs{name:probe}": ["count>0"],
    presence_sent: ["count>0"],
    dropped_iterations: ["count==0"],
    monitor_checks: ["rate==1.0"],
  },
};

function step(runStart) {
  const elapsed = (Date.now() - runStart) / 1000;
  for (let index = rates.length - 1; index >= 0; index--) {
    if (elapsed >= stepStarts[index]) {
      return String(rates[index]);
    }
  }
  return "settle";
}

function jsonParams(token) {
  return {
    headers: { "Content-Type": "application/json", "X-Auth-Token": token },
  };
}

function mobileUrl(user) {
  return `${auth}/users/${user.uuid}/external/mobile`;
}

function presenceUrl(user) {
  return `${chatd}/users/${user.uuid}/presences`;
}

function mobileTokenBody(user) {
  return JSON.stringify({ token: `${MOBILE_TOKEN_PREFIX}${user.uuid}` });
}

function inBatches(items, send) {
  const results = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    results.push(...send(items.slice(start, start + BATCH_SIZE)));
  }
  return results;
}

function logIn(indexes) {
  const names = indexes.map((index) =>
    usernameTemplate.replaceAll("{i}", String(index)),
  );
  return http
    .batch(
      names.map((name) =>
        tokenRequest(engine, name, userPassword, userTokenSeconds),
      ),
    )
    .map((response, n) => {
      if (response.status !== 200) {
        throw new Error(`token for ${names[n]}: HTTP ${response.status}`);
      }
      const token = response.json("data");
      return { name: names[n], uuid: token.metadata.uuid, token: token.token };
    });
}

function batchExpect(requests, expected, what) {
  return http.batch(requests).map((response, n) => {
    if (response.status !== expected) {
      throw new Error(
        `${what} #${n}: HTTP ${response.status} ${response.body}`,
      );
    }
    return response;
  });
}

export function setup() {
  const setupStart = Date.now();
  const indexes = Array.from({ length: sessions + senders }, (_, i) => i);
  const users = inBatches(indexes, logIn);
  const probing = users.slice(0, probeSessions);
  // wazo-auth registers its external auth types on the first listing only:
  // until then, a fresh stack refuses the mobile auth as an unknown type
  batchExpect(
    [
      [
        "GET",
        `${auth}/users/${probing[0].uuid}/external`,
        null,
        jsonParams(probing[0].token),
      ],
    ],
    200,
    "external auths",
  );
  inBatches(probing, (batch) =>
    batchExpect(
      batch.map((user) => [
        "PUT",
        mobileUrl(user),
        mobileTokenBody(user),
        jsonParams(user.token),
      ]),
      200,
      "mobile auth",
    ),
  );
  const sending = users.slice(sessions);
  batchExpect(
    sending.map((user) => [
      "GET",
      presenceUrl(user),
      null,
      jsonParams(user.token),
    ]),
    200,
    "presence",
  ).forEach((response, n) => {
    sending[n].presence = {
      state: response.json("state"),
      status: response.json("status"),
    };
  });
  console.log(
    `${sessions} sessions on ${vus} VUs, ${probeSessions} probing every` +
      ` ${probeIntervalSeconds}s, ${timingSessions} timing presence;` +
      ` ${senders} users setting their presence at ${rates.join(", ")}/s,` +
      ` ${stepSeconds}s each after ${settleSeconds}s`,
  );
  return { runStart: Date.now(), setupStart, users };
}

export function teardown({ setupStart, users }) {
  for (const user of users.slice(sessions)) {
    check(
      http.put(
        presenceUrl(user),
        JSON.stringify(user.presence),
        jsonParams(user.token),
      ),
      { "presence restored": (r) => r.status === 204 },
    );
  }
  const adminToken = createToken(engine, adminUsername, adminPassword).token;
  inBatches(users.slice(0, probeSessions), (batch) =>
    http
      .batch(
        batch.map((user) => [
          "DELETE",
          mobileUrl(user),
          null,
          jsonParams(adminToken),
        ]),
      )
      .map((response) =>
        check(response, { "mobile auth deleted": (r) => r.status === 204 }),
      ),
  );
  checkStackInvariants(setupStart);
}

// What a ringall queue makes wazo-chatd send for every rung member, without
// the calls: the status carries the time it was set, to time its delivery
export function sendPresence({ runStart, users }) {
  const user = users[sessions + (exec.scenario.iterationInTest % senders)];
  const sentAt = Date.now();
  presenceSent.add(1, { rate: step(runStart) });
  const response = http.put(
    presenceUrl(user),
    JSON.stringify({ state: "available", status: `${STATUS_PREFIX}${sentAt}` }),
    { ...jsonParams(user.token), tags: { name: "presence" } },
  );
  check(response, { "presence sent": (r) => r.status === 204 });
}

function holdSession(user, { probing, timing }, runStart) {
  const ws = new WebSocket(
    `wss://${engine}/api/websocketd/?token=${user.token}&version=2`,
  );
  const counts = {};
  const intervals = [];
  let probeSentAt = null;
  let closing = false;

  // a counter sample per message would cost the generator more than the
  // websocket does, so the counts go out every few seconds
  function flush() {
    for (const [rate, count] of Object.entries(counts)) {
      presenceReceived.add(count, { rate });
      delete counts[rate];
    }
  }

  // Re-sending its push token: wazo-auth emits the update to the user's own
  // session alone, an event that shares the bus with the presence updates
  async function probe() {
    if (probeSentAt !== null) {
      eventLost.add(1, { rate: step(runStart) });
    }
    probeSentAt = Date.now();
    const response = await http.asyncRequest(
      "PUT",
      mobileUrl(user),
      mobileTokenBody(user),
      { ...jsonParams(user.token), tags: { name: "probe" } },
    );
    check(response, { "probe sent": (r) => r.status === 200 });
  }

  function presenceArrived(raw, rate) {
    counts[rate] = (counts[rate] || 0) + 1;
    if (!timing) {
      return;
    }
    const status = JSON.parse(raw).data.data.status || "";
    if (status.startsWith(STATUS_PREFIX)) {
      const sentAt = Number(status.slice(STATUS_PREFIX.length));
      presenceLatency.add(Date.now() - sentAt, { rate });
    }
  }

  function started() {
    intervals.push(setInterval(flush, FLUSH_SECONDS * 1000));
    if (!probing) {
      return;
    }
    // spread the probes of the sessions opened together
    setTimeout(
      () => {
        probe();
        intervals.push(setInterval(probe, probeIntervalSeconds * 1000));
      },
      Math.random() * probeIntervalSeconds * 1000,
    );
  }

  ws.onmessage = (event) => {
    const raw = event.data;
    if (raw.includes(`"${PRESENCE_EVENT}"`)) {
      presenceArrived(raw, step(runStart));
      return;
    }
    const message = JSON.parse(raw);
    switch (message.op) {
      case "init":
        for (const name of [PRESENCE_EVENT, PROBE_EVENT]) {
          ws.send(
            JSON.stringify({ op: "subscribe", data: { event_name: name } }),
          );
        }
        ws.send(JSON.stringify({ op: "start" }));
        break;
      case "start":
        started();
        break;
      case "event":
        if (message.data.name === PROBE_EVENT && probeSentAt !== null) {
          eventLatency.add(Date.now() - probeSentAt, { rate: step(runStart) });
          probeSentAt = null;
        }
        break;
    }
  };
  ws.onerror = (event) => {
    // a pong k6 writes once our close frame is sent fails harmlessly
    if (closing && event.error.includes("close sent")) {
      return;
    }
    console.error(`websocket of ${user.uuid}: ${event.error}`);
  };
  ws.onclose = () => {
    intervals.forEach(clearInterval);
    flush();
  };
  setTimeout(
    () => {
      closing = true;
      ws.close();
    },
    runStart + runSeconds * 1000 - Date.now(),
  );
}

// One VU per session would take the load generator down before the stack
export function holdSessions({ runStart, users }) {
  const first = exec.scenario.iterationInTest;
  for (let index = first; index < sessions; index += vus) {
    // spread the opening, a burst makes websocketd time out on wazo-auth
    const opensAt = runStart + (index / sessions) * openSeconds * 1000;
    setTimeout(
      () =>
        holdSession(
          users[index],
          { probing: index < probeSessions, timing: index < timingSessions },
          runStart,
        ),
      opensAt - Date.now(),
    );
  }
}
