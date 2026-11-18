// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "k6/timers";
import { WebSocket } from "k6/websockets";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
import { playLogin } from "../../modules/mobile-login.js";
import { createToken, tokenRequest } from "../../modules/wazo.js";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
if (!engine || !adminUsername || !adminPassword) {
  throw new Error(
    "WAZO_ENGINE, WAZO_ADMIN_USERNAME and WAZO_ADMIN_PASSWORD are required",
  );
}
const createUsers = __ENV.CREATE_USERS === "true";
const tenant = __ENV.WAZO_TENANT;
if (createUsers && !tenant) {
  throw new Error("WAZO_TENANT is required with CREATE_USERS=true");
}

const users = Number(__ENV.USERS || 5000);
const sessions = Number(__ENV.SESSIONS || users);
if (sessions < 1 || sessions > users) {
  throw new Error(
    `SESSIONS (${sessions}) must be between 1 and USERS (${users})`,
  );
}
const usernameTemplate = __ENV.USERNAME_TEMPLATE || "dev+user{i}@wazo.io";
const userPassword = __ENV.USER_PASSWORD || "secret";
const rampSteps = Number(__ENV.RAMP_STEPS || 10);
const stepSeconds = Number(__ENV.STEP_SECONDS || 60);
const holdSeconds = Number(__ENV.HOLD_SECONDS || 120);
const settleSeconds = Number(__ENV.SETTLE_SECONDS || 60);
const probeSessions = Math.min(Number(__ENV.PROBE_SESSIONS || 100), sessions);
const probeIntervalSeconds = Number(__ENV.PROBE_INTERVAL_SECONDS || 10);
const sessionsPerVu = Number(__ENV.SESSIONS_PER_VU || 50);

const CREATED_USER_PREFIX = "load-bindings-";
const BATCH_SIZE = 50;
const PROBE_EVENT = "auth_user_external_auth_updated";
const subscribedEvents = [
  ...JSON.parse(open("../../assets/mobile-websocket-events.json")),
  PROBE_EVENT,
];

const sessionsPerStep = Math.ceil(sessions / rampSteps);
const vus = Math.ceil(sessions / sessionsPerVu);
const sessionSeconds = rampSteps * stepSeconds + holdSeconds;
const runSeconds = settleSeconds + sessionSeconds;
// outlives setup, which logs every user in before the sessions start
const userTokenSeconds = runSeconds + 3600;

const auth = `https://${engine}/api/auth/0.1`;

const subscribeDuration = new Trend("ws_subscribe_duration", true);
const eventLatency = new Trend("bus_event_latency", true);
const eventLost = new Counter("bus_event_lost");

export const options = {
  insecureSkipTLSVerify: true,
  // url carries the user's token or uuid: a series per session otherwise
  systemTags: [
    "proto",
    "subproto",
    "status",
    "method",
    "name",
    "group",
    "check",
    "error",
    "error_code",
    "tls_version",
    "scenario",
    "service",
    "expected_response",
  ],
  setupTimeout: "30m",
  teardownTimeout: "30m",
  scenarios: {
    sessions: {
      executor: "per-vu-iterations",
      vus,
      iterations: 1,
      maxDuration: `${runSeconds + 60}s`,
    },
  },
  thresholds: {
    // An empty metric passes every other threshold
    "http_reqs{name:probe}": ["count>0"],
    bus_event_lost: ["count==0"],
    checks: ["rate==1.0"],
    monitor_checks: ["rate==1.0"],
  },
};

function jsonParams(token, extraHeaders = {}) {
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
      ...extraHeaders,
    },
  };
}

function username(index) {
  if (createUsers) {
    return `${CREATED_USER_PREFIX}${index}`;
  }
  return usernameTemplate.replaceAll("{i}", String(index));
}

function mobileUrl(uuid) {
  return `${auth}/users/${uuid}/external/mobile`;
}

function pushToken(user) {
  return `${CREATED_USER_PREFIX}${user.uuid}`;
}

function mobileTokenBody(user) {
  return JSON.stringify({ token: pushToken(user) });
}

function deleteUser(adminToken, uuid) {
  const params = jsonParams(adminToken, { "Wazo-Tenant": tenant });
  // a user left by a stopped run may not have reached its registration
  check(http.del(mobileUrl(uuid), null, params), {
    "mobile auth deleted": (r) => [204, 404].includes(r.status),
  });
  check(http.del(`${auth}/users/${uuid}`, null, params), {
    "user deleted": (r) => r.status === 204,
  });
}

// A run stopped before its teardown leaves its users behind
function deleteCreatedUsers(adminToken) {
  const response = http.get(
    `${auth}/users?search=${CREATED_USER_PREFIX}&recurse=true&limit=100000`,
    jsonParams(adminToken, { "Wazo-Tenant": tenant }),
  );
  if (response.status !== 200) {
    throw new Error(
      `listing ${CREATED_USER_PREFIX} users: HTTP ${response.status}`,
    );
  }
  for (const user of response.json("items")) {
    deleteUser(adminToken, user.uuid);
  }
}

function createUser(adminToken, index) {
  const response = http.post(
    `${auth}/users`,
    JSON.stringify({ username: username(index), password: userPassword }),
    jsonParams(adminToken, { "Wazo-Tenant": tenant }),
  );
  if (response.status !== 200) {
    throw new Error(`user ${username(index)}: HTTP ${response.status}`);
  }
}

function inBatches(items, send) {
  const results = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    results.push(...send(items.slice(start, start + BATCH_SIZE)));
  }
  return results;
}

function logIn(indexes) {
  const responses = http.batch(
    indexes.map((index) =>
      tokenRequest(engine, username(index), userPassword, userTokenSeconds),
    ),
  );
  return responses.map((response, n) => {
    const name = username(indexes[n]);
    if (response.status !== 200) {
      throw new Error(`token for ${name}: HTTP ${response.status}`);
    }
    const token = response.json("data");
    return { name, uuid: token.metadata.uuid, token: token.token };
  });
}

// PUT creates the mobile auth, or updates one a stopped run left
function registerPushTokens(batch) {
  const responses = http.batch(
    batch.map((user) => [
      "PUT",
      mobileUrl(user.uuid),
      mobileTokenBody(user),
      jsonParams(user.token),
    ]),
  );
  responses.forEach((response, n) => {
    if (response.status !== 200) {
      throw new Error(
        `mobile auth of ${batch[n].name}: HTTP ${response.status} ${response.body}`,
      );
    }
  });
  return batch;
}

// wazo-auth registers its external auth types on the first listing only:
// until then, a fresh stack refuses the mobile auth as an unknown type
function listExternalAuths(user) {
  const response = http.get(
    `${auth}/users/${user.uuid}/external`,
    jsonParams(user.token),
  );
  if (response.status !== 200) {
    throw new Error(`external auths: HTTP ${response.status} ${response.body}`);
  }
}

export function setup() {
  const runStart = Date.now();
  if (createUsers) {
    const adminToken = createToken(engine, adminUsername, adminPassword).token;
    deleteCreatedUsers(adminToken);
    for (let index = 0; index < users; index++) {
      createUser(adminToken, index);
    }
  }
  const indexes = Array.from({ length: users }, (_, index) => index);
  const loggedIn = inBatches(indexes, logIn);
  listExternalAuths(loggedIn[0]);
  inBatches(loggedIn, registerPushTokens);
  console.log(
    `${users} mobile users, ${sessions} sessions of ${subscribedEvents.length}` +
      ` events on ${vus} VUs, after ${settleSeconds}s` +
      ` ${sessionsPerStep} more every ${stepSeconds}s,` +
      ` then ${holdSeconds}s;` +
      ` the first ${probeSessions} probe every ${probeIntervalSeconds}s`,
  );
  return { runStart, users: loggedIn };
}

export function teardown({ runStart, users: loggedIn }) {
  const adminToken = createToken(engine, adminUsername, adminPassword).token;
  if (createUsers) {
    for (const user of loggedIn) {
      deleteUser(adminToken, user.uuid);
    }
  } else {
    inBatches(loggedIn, (batch) =>
      http
        .batch(
          batch.map((user) => [
            "DELETE",
            mobileUrl(user.uuid),
            null,
            jsonParams(adminToken),
          ]),
        )
        .map((response) =>
          check(response, { "mobile auth deleted": (r) => r.status === 204 }),
        ),
    );
  }
  checkStackInvariants(runStart);
}

// The sessions the ramp has opened by now, to read latency against
function plannedSessions(rampStart) {
  const step = Math.floor((Date.now() - rampStart) / (stepSeconds * 1000));
  return Math.min(
    sessions,
    (Math.min(step, rampSteps - 1) + 1) * sessionsPerStep,
  );
}

function holdSession(user, probing, rampStart) {
  const sessionEnd = rampStart + sessionSeconds * 1000;
  const ws = new WebSocket(
    `wss://${engine}/api/websocketd/?token=${user.token}&version=2`,
  );
  let subscribeStart = 0;
  let acknowledged = 0;
  let probeSentAt = null;
  let firstProbeTimer = null;
  let probeTimer = null;
  let closing = false;

  // Re-sending its push token, as the app does on refresh: wazo-auth emits
  // the update to the user's own session, through every binding on the way
  async function probe() {
    if (probeSentAt !== null) {
      eventLost.add(1);
    }
    probeSentAt = Date.now();
    const response = await http.asyncRequest(
      "PUT",
      mobileUrl(user.uuid),
      mobileTokenBody(user),
      { ...jsonParams(user.token), tags: { name: "probe" } },
    );
    check(response, { "probe sent": (r) => r.status === 200 });
  }

  function received(message) {
    const tags = { sessions: String(plannedSessions(rampStart)) };
    switch (message.op) {
      case "init":
        subscribeStart = Date.now();
        for (const event of subscribedEvents) {
          ws.send(
            JSON.stringify({ op: "subscribe", data: { event_name: event } }),
          );
        }
        ws.send(JSON.stringify({ op: "start" }));
        break;
      case "subscribe":
        acknowledged += message.code === 0 ? 1 : 0;
        break;
      case "start":
        subscribeDuration.add(Date.now() - subscribeStart, tags);
        check(acknowledged, {
          "every event subscribed": (count) =>
            count === subscribedEvents.length,
        });
        if (!probing) {
          break;
        }
        // spread the probes of the sessions opened together
        firstProbeTimer = setTimeout(
          () => {
            probe();
            probeTimer = setInterval(probe, probeIntervalSeconds * 1000);
          },
          Math.random() * probeIntervalSeconds * 1000,
        );
        break;
      case "event":
        if (message.data.name === PROBE_EVENT && probeSentAt !== null) {
          eventLatency.add(Date.now() - probeSentAt, tags);
          probeSentAt = null;
        }
        break;
    }
  }

  ws.onmessage = (event) => received(JSON.parse(event.data));
  ws.onerror = (event) => {
    // a pong k6 writes once our close frame is sent fails harmlessly
    if (closing && event.error.includes("close sent")) {
      return;
    }
    console.error(`websocket of ${user.uuid}: ${event.error}`);
  };
  ws.onclose = () => {
    clearTimeout(firstProbeTimer);
    clearInterval(probeTimer);
  };
  setTimeout(() => {
    closing = true;
    ws.close();
  }, sessionEnd - Date.now());
}

// The app's login needs a telephony user: created users only exist in
// wazo-auth, so their sessions open the websocket straight away
function openSession(user, probing, rampStart) {
  const holdWebsocket = () => holdSession(user, probing, rampStart);
  if (createUsers) {
    holdWebsocket();
    return;
  }
  playLogin(engine, user, pushToken(user), holdWebsocket);
}

// One VU per session would take the load generator down before the stack
export default function ({ users: loggedIn }) {
  // lets the stack drain the push token registrations of setup first
  const rampStart = exec.scenario.startTime + settleSeconds * 1000;
  // a step's sessions open one after the other across the step, as logins
  // do, rather than all in the same millisecond
  const openingInterval = (stepSeconds * 1000) / sessionsPerStep;
  for (let index = exec.vu.idInTest - 1; index < sessions; index += vus) {
    const opensAt = rampStart + index * openingInterval;
    setTimeout(
      () => openSession(loggedIn[index], index < probeSessions, rampStart),
      opensAt - Date.now(),
    );
  }
}
