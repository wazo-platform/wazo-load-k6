// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { clearInterval, setInterval, setTimeout } from "k6/timers";
import { WebSocket } from "k6/websockets";
import { loginMemberAgents, logoffMemberAgents } from "../../modules/agents.js";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
import { createQueues, deleteQueues } from "../../modules/queues.js";
import {
  memberBase,
  memberCallCapSeconds,
  members,
  placeCall,
  registerMember,
  talkSeconds,
} from "../../modules/sip-call.js";
import { createToken, tokenRequest } from "../../modules/wazo.js";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
const tenant = __ENV.WAZO_TENANT;
if (!tenant) {
  throw new Error("WAZO_TENANT is required");
}

const queueSize = Number(__ENV.QUEUE_SIZE || 10);
const queues = Math.floor(members / queueSize);
if (queues < 1) {
  throw new Error(`MEMBERS (${members}) is below QUEUE_SIZE (${queueSize})`);
}
const callsPerMinute = Number(__ENV.CALLS_PER_MINUTE || 30);
const phaseSeconds = Number(__ENV.PHASE_SECONDS || 300);
// lets the calls of a phase hang up before the next one starts
const gapSeconds = Number(__ENV.GAP_SECONDS || 180);
const warmupSeconds = Number(__ENV.WARMUP_SECONDS || 60);
const sessions = Number(__ENV.SESSIONS || 100);
const sessionsPerVu = Number(__ENV.SESSIONS_PER_VU || 25);
const usernameTemplate = __ENV.USERNAME_TEMPLATE || "dev+user{i}@wazo.io";
const userPassword = __ENV.USER_PASSWORD || "secret";
const probeSessions = Math.min(Number(__ENV.PROBE_SESSIONS ?? 2), sessions);
const probeIntervalSeconds = Number(__ENV.PROBE_INTERVAL_SECONDS || 5);

const STRATEGIES = ["rrmemory", "ringall"];
const EXTEN_BASES = { rrmemory: 31000, ringall: 32000 };
const PRESENCE_EVENT = "chatd_presence_updated";
const PROBE_STATUS_PREFIX = "load-queue-";
const FLUSH_SECONDS = 10;

const phaseStarts = STRATEGIES.map(
  (_, index) => warmupSeconds + index * (phaseSeconds + gapSeconds),
);
const callersEnd = phaseStarts[STRATEGIES.length - 1] + phaseSeconds;
const runSeconds = callersEnd + gapSeconds;
const memberSeconds = runSeconds + memberCallCapSeconds;
const vus = Math.ceil(sessions / sessionsPerVu);
const concurrency = (callsPerMinute / 60) * talkSeconds;
// calls in progress are Poisson around the mean, so 3 deviations cover the peak
const callerVus = Math.ceil(concurrency + 3 * Math.sqrt(concurrency));
if (members < callerVus) {
  throw new Error(`MEMBERS (${members}) cannot answer ${callerVus} calls`);
}

const presenceReceived = new Counter("presence_events_received");
const presenceLatency = new Trend("presence_event_latency", true);
const presenceSent = new Counter("presence_probe_sent");
const presenceLost = new Counter("presence_probe_lost");

function callerScenario(strategy, index) {
  return {
    executor: "constant-arrival-rate",
    exec: `call_${strategy}`,
    startTime: `${phaseStarts[index]}s`,
    rate: callsPerMinute,
    timeUnit: "1m",
    duration: `${phaseSeconds}s`,
    gracefulStop: `${memberCallCapSeconds}s`,
    preAllocatedVUs: callerVus,
    maxVUs: callerVus,
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
    members: {
      executor: "per-vu-iterations",
      exec: "member",
      vus: members,
      iterations: 1,
      maxDuration: `${memberSeconds + 10}s`,
    },
    sessions: {
      executor: "per-vu-iterations",
      exec: "holdSessions",
      vus,
      iterations: 1,
      maxDuration: `${runSeconds + 60}s`,
    },
    ...Object.fromEntries(
      STRATEGIES.map((strategy, index) => [
        `caller_${strategy}`,
        callerScenario(strategy, index),
      ]),
    ),
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    "checks{check:call answered}": ["rate>0.99"],
    presence_probe_sent: ["count>0"],
    presence_probe_lost: ["count==0"],
    monitor_checks: ["rate==1.0"],
  },
};

function phase(runStart) {
  const elapsed = (Date.now() - runStart) / 1000;
  for (let index = STRATEGIES.length - 1; index >= 0; index--) {
    if (elapsed >= phaseStarts[index] + phaseSeconds) {
      return `${STRATEGIES[index]}-drain`;
    }
    if (elapsed >= phaseStarts[index]) {
      return STRATEGIES[index];
    }
  }
  return "idle";
}

function queueMembers() {
  return Array.from({ length: queues }, (_, queue) =>
    Array.from({ length: queueSize }, (_, slot) =>
      String(memberBase + queue * queueSize + slot),
    ),
  );
}

function userParams(user) {
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": user.token,
    },
  };
}

function presenceUrl(user) {
  return `https://${engine}/api/chatd/1.0/users/${user.uuid}/presences`;
}

function logIn() {
  const indexes = Array.from({ length: sessions }, (_, index) => index);
  const names = indexes.map((index) =>
    usernameTemplate.replaceAll("{i}", String(index)),
  );
  const responses = http.batch(
    names.map((name) =>
      tokenRequest(engine, name, userPassword, runSeconds + 3600),
    ),
  );
  return responses.map((response, index) => {
    if (response.status !== 200) {
      throw new Error(`token for ${names[index]}: HTTP ${response.status}`);
    }
    const token = response.json("data");
    return {
      name: names[index],
      uuid: token.metadata.uuid,
      token: token.token,
    };
  });
}

function readPresence(user) {
  const response = http.get(presenceUrl(user), userParams(user));
  if (response.status !== 200) {
    throw new Error(`presence of ${user.name}: HTTP ${response.status}`);
  }
  return { state: response.json("state"), status: response.json("status") };
}

export function setup() {
  const runStart = Date.now();
  const adminToken = createToken(engine, adminUsername, adminPassword).token;
  deleteQueues(adminToken, tenant);
  const extens = Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      createQueues(adminToken, tenant, {
        strategy,
        extenBase: EXTEN_BASES[strategy],
        members: queueMembers(),
      }),
    ]),
  );
  loginMemberAgents();
  const users = logIn();
  for (const user of users.slice(0, probeSessions)) {
    user.presence = readPresence(user);
  }
  console.log(
    `${queues} queues of ${queueSize} agents per strategy,` +
      ` ${callsPerMinute} calls/min for ${phaseSeconds}s on each of` +
      ` ${STRATEGIES.join(" then ")} from ${phaseStarts.join("s, ")}s,` +
      ` ${gapSeconds}s apart; ${sessions} sessions on ${vus} VUs,` +
      ` ${probeSessions} probing every ${probeIntervalSeconds}s`,
  );
  return { runStart: Date.now(), setupStart: runStart, extens, users };
}

export function teardown({ setupStart, users }) {
  logoffMemberAgents();
  for (const user of users.slice(0, probeSessions)) {
    check(
      http.put(
        presenceUrl(user),
        JSON.stringify(user.presence),
        userParams(user),
      ),
      { "presence restored": (r) => r.status === 204 },
    );
  }
  deleteQueues(createToken(engine, adminUsername, adminPassword).token, tenant);
  checkStackInvariants(setupStart);
}

export function member() {
  const uas = registerMember(exec.scenario.iterationInTest);
  while (exec.instance.currentTestRunDuration < memberSeconds * 1000) {
    const callersDone =
      exec.instance.currentTestRunDuration > runSeconds * 1000;
    if (callersDone && exec.instance.vusActive <= members) {
      break;
    }
    sleep(1);
  }
  uas.stop();
}

function callQueue({ extens }, strategy) {
  const queue = exec.scenario.iterationInTest % queues;
  placeCall(extens[strategy][queue]);
}

export function call_rrmemory(data) {
  callQueue(data, "rrmemory");
}

export function call_ringall(data) {
  callQueue(data, "ringall");
}

function holdSession(user, probing, runStart) {
  const ws = new WebSocket(
    `wss://${engine}/api/websocketd/?token=${user.token}&version=2`,
  );
  const counts = {};
  let probeSentAt = null;
  const intervals = [];
  let closing = false;

  // a counter sample per message would cost the generator more than the
  // websocket does, so the counts go out every few seconds
  function flush() {
    for (const [name, count] of Object.entries(counts)) {
      presenceReceived.add(count, { phase: name });
      delete counts[name];
    }
  }

  // wazo-chatd sends a presence change to every session of the tenant; the
  // status carries the time it was set, for every session to time it
  async function probe() {
    if (probeSentAt !== null) {
      presenceLost.add(1, { phase: phase(runStart) });
    }
    probeSentAt = Date.now();
    presenceSent.add(1, { phase: phase(runStart) });
    const response = await http.asyncRequest(
      "PUT",
      presenceUrl(user),
      JSON.stringify({
        state: "available",
        status: `${PROBE_STATUS_PREFIX}${probeSentAt}`,
      }),
      { ...userParams(user), tags: { name: "probe" } },
    );
    check(response, { "probe sent": (r) => r.status === 204 });
  }

  function probeReceived(raw) {
    const presence = JSON.parse(raw).data.data;
    const status = presence.status || "";
    if (!status.startsWith(PROBE_STATUS_PREFIX)) {
      return;
    }
    const sentAt = Number(status.slice(PROBE_STATUS_PREFIX.length));
    presenceLatency.add(Date.now() - sentAt, { phase: phase(runStart) });
    if (presence.uuid === user.uuid && sentAt === probeSentAt) {
      probeSentAt = null;
    }
  }

  ws.onmessage = (event) => {
    const raw = event.data;
    if (raw.includes(`"${PRESENCE_EVENT}"`)) {
      const name = phase(runStart);
      counts[name] = (counts[name] || 0) + 1;
      if (raw.includes(PROBE_STATUS_PREFIX)) {
        probeReceived(raw);
      }
      return;
    }
    const message = JSON.parse(raw);
    if (message.op === "init") {
      ws.send(
        JSON.stringify({
          op: "subscribe",
          data: { event_name: PRESENCE_EVENT },
        }),
      );
      ws.send(JSON.stringify({ op: "start" }));
    }
    if (message.op === "start") {
      intervals.push(setInterval(flush, FLUSH_SECONDS * 1000));
      if (probing) {
        intervals.push(setInterval(probe, probeIntervalSeconds * 1000));
      }
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
    holdSession(users[index], index < probeSessions, runStart);
  }
}
