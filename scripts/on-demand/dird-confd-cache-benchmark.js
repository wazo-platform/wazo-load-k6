// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Directory lookups in bursts and the unfiltered listing of the `wazo` source,
// with a direct latency probe of wazo-confd beside them: what wazo-dird asks
// of wazo-confd, and what a cache of the confd users changes. Run it once for
// each variant of the stack, with ARM naming it (see the README). The terms
// come from the users of WAZO_TENANT, which setup() reads from wazo-confd.

import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
import {
  readMonitor,
  stackMatcher,
} from "../../modules/monitor-checks/check.js";
import {
  buildTermPool,
  coldTerm,
  createBurstGenerator,
} from "../../modules/directory-load.js";
import { createToken } from "../../modules/wazo.js";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
const tenant = __ENV.WAZO_TENANT;
if (!engine || !adminUsername || !adminPassword || !tenant) {
  throw new Error(
    "WAZO_ENGINE, WAZO_ADMIN_USERNAME, WAZO_ADMIN_PASSWORD and WAZO_TENANT are required",
  );
}

const loadProfile = __ENV.LOAD_PROFILE || "steady";
if (!["steady", "smoke", "ramp"].includes(loadProfile)) {
  throw new Error(`LOAD_PROFILE ${loadProfile}: steady, smoke or ramp`);
}
const smoke = loadProfile === "smoke";

// What names the variant of the stack under test; the operator sets the stack
const arm = __ENV.ARM;
// A/B runs compare variants: one that is slower than the budgets must still
// report its numbers
const reportOnly = __ENV.AB_MODE === "report";

const lookupRate = Number(__ENV.LOOKUP_RATE || (smoke ? 3 : 15));
const listingRate = Number(__ENV.LISTING_RATE || (smoke ? 6 : 15));
const probeRate = Number(__ENV.PROBE_RATE || (smoke ? 1 : 2));
const warmupSeconds = Number(__ENV.WARMUP_SECONDS || (smoke ? 5 : 60));
const durationSeconds = Number(__ENV.DURATION_SECONDS || (smoke ? 15 : 300));
const stampedeVus = Number(__ENV.STAMPEDE_VUS || (smoke ? 10 : 50));
const tokenCount = Number(__ENV.TOKENS || (smoke ? 10 : 100));
const usersExpected = Number(__ENV.USERS_EXPECTED || 4500);
const poolRatio = Number(__ENV.POOL_RATIO || 2.75);
const burstOptions = {
  exponent: Number(__ENV.ZIPF_EXPONENT || 0.7),
  churn: Number(__ENV.CHURN || 0.25),
  minSize: Number(__ENV.BURST_MIN || 7),
  maxSize: Number(__ENV.BURST_MAX || 12),
  seed: Number(__ENV.SEED || 1),
};
const dirdProfile = __ENV.DIRD_PROFILE || "default";
const sourceName = __ENV.SOURCE_NAME;

const dird = `https://${engine}/api/dird/0.1`;
const confd = `https://${engine}/api/confd/1.1`;

const USERS_PAGE = 1000;
const STAMPEDE_SECONDS = 10;
const GRACEFUL_STOP_SECONDS = 5;
const RAMP_STEP_SECONDS = Number(__ENV.RAMP_STEP_SECONDS || 60);
// Shares of LOOKUP_RATE, one step each: the knee is where a step leaves budget
const RAMP_SHARES = [0.2, 0.5, 1, 1.5, 2, 3];
// Tokens outlive the run, setup and teardown
const TOKEN_MARGIN_SECONDS = 300;

const loadSeconds =
  loadProfile === "ramp"
    ? RAMP_SHARES.length * RAMP_STEP_SECONDS
    : durationSeconds;
const measuredStart = STAMPEDE_SECONDS + warmupSeconds + GRACEFUL_STOP_SECONDS;
const runSeconds = measuredStart + loadSeconds;

// One iteration is one burst, so the rate is in bursts: a lookup rate in
// lookups per second divided by the lookups in a burst
const burstsPerSecond =
  lookupRate / ((burstOptions.minSize + burstOptions.maxSize) / 2);
const burstsPerMinute = Math.max(1, Math.round(burstsPerSecond * 60));
const burstVus = {
  preAllocatedVUs: Math.ceil(burstsPerSecond * 5) + 5,
  maxVUs: Math.max(50, Math.ceil(burstsPerSecond * 30)),
};

function lookupScenario(extra) {
  return {
    timeUnit: "1m",
    gracefulStop: `${GRACEFUL_STOP_SECONDS}s`,
    ...burstVus,
    exec: "lookupBurst",
    ...extra,
  };
}

const steadyLookup =
  loadProfile === "ramp"
    ? lookupScenario({
        executor: "ramping-arrival-rate",
        startRate: Math.round(burstsPerMinute * RAMP_SHARES[0]),
        stages: RAMP_SHARES.map((share) => ({
          target: Math.round(burstsPerMinute * share),
          duration: `${RAMP_STEP_SECONDS}s`,
        })),
        startTime: `${measuredStart}s`,
      })
    : lookupScenario({
        executor: "constant-arrival-rate",
        rate: burstsPerMinute,
        duration: `${durationSeconds}s`,
        startTime: `${measuredStart}s`,
      });

// Same load as the steady phase, measured apart: the cold-cache numbers
const warmupLookup = lookupScenario({
  executor: "constant-arrival-rate",
  rate: burstsPerMinute,
  duration: `${warmupSeconds}s`,
  startTime: `${STAMPEDE_SECONDS}s`,
});

const wholeRun = {
  executor: "constant-arrival-rate",
  duration: `${runSeconds - STAMPEDE_SECONDS}s`,
  startTime: `${STAMPEDE_SECONDS}s`,
  gracefulStop: `${GRACEFUL_STOP_SECONDS}s`,
};

// Latency budgets, sized for a 4 vCPU / 16 GiB stack (AWS t3.xlarge). In
// report mode they always hold, which still lists the sub-metrics in the
// summary; only the health of the generator and of the stack gates the run
function budget(metric, limits) {
  return [metric, reportOnly ? ["p(95)>=0"] : limits];
}

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    stampede: {
      executor: "per-vu-iterations",
      vus: stampedeVus,
      iterations: 1,
      maxDuration: `${STAMPEDE_SECONDS}s`,
      gracefulStop: `${GRACEFUL_STOP_SECONDS}s`,
      exec: "stampede",
    },
    "lookup-warmup": warmupLookup,
    lookup: steadyLookup,
    listing: {
      ...wholeRun,
      rate: listingRate,
      timeUnit: "1m",
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: "listing",
    },
    "confd-probe": {
      ...wholeRun,
      rate: probeRate,
      timeUnit: "1s",
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "confdProbe",
    },
  },
  tags: arm ? { arm } : {},
  thresholds: Object.fromEntries([
    budget("http_req_duration{scenario:lookup,name:lookup}", [
      "p(95)<500",
      "p(99)<1500",
    ]),
    budget("http_req_duration{scenario:lookup-warmup,name:lookup}", [
      "p(95)<1500",
    ]),
    budget("http_req_duration{scenario:stampede,name:stampede}", [
      "p(99)<3000",
    ]),
    budget("http_req_duration{scenario:listing,name:listing}", ["p(95)<1500"]),
    budget("http_req_duration{scenario:confd-probe}", ["p(95)<500"]),
    // An empty metric passes every other threshold
    ["http_reqs{scenario:lookup,name:lookup}", ["count>0"]],
    ["http_reqs{scenario:stampede,name:stampede}", ["count>0"]],
    ["http_reqs{scenario:listing,name:listing}", ["count>0"]],
    ["http_reqs{scenario:confd-probe}", ["count>0"]],
    // The generator must offer the load it is told to
    ["dropped_iterations", ["count==0"]],
    ["http_req_blocked", ["p(95)<100"]],
    ["http_req_failed", ["rate<0.01"]],
    ["checks", ["rate==1.0"]],
    ["monitor_checks", ["rate==1.0"]],
  ]),
};

const confdRequests = new Counter("confd_requests");
const confdServerSeconds = new Counter("confd_server_seconds");

function headers(token) {
  return { "X-Auth-Token": token, "Wazo-Tenant": tenant };
}

function get(url, token, name) {
  return http.get(url, { headers: headers(token), tags: { name } });
}

function lookupRequest(token, entry, name) {
  const query = `term=${encodeURIComponent(entry.term)}`;
  return [
    "GET",
    `${dird}/directories/lookup/${dirdProfile}?${query}`,
    null,
    {
      headers: headers(token),
      tags: { name, term_kind: entry.hit ? "hit" : "miss" },
    },
  ];
}

function checkLookup(response, entry) {
  check(response, {
    "lookup answered": (r) => r.status === 200,
    "lookup found the user": (r) =>
      !entry.hit || (r.status === 200 && r.json("results").length > 0),
  });
}

// Every user of the tenant, as wazo-dird sees them: the directory view
function listDirectoryUsers(token) {
  const users = [];
  let total;
  do {
    const response = get(
      `${confd}/users?view=directory&recurse=true&order=id&limit=${USERS_PAGE}&offset=${users.length}`,
      token,
      "setup-users",
    );
    if (response.status !== 200) {
      throw new Error(`users: HTTP ${response.status}`);
    }
    total = response.json("total");
    users.push(...response.json("items"));
  } while (users.length < total);
  return users;
}

function sourceUuid(token) {
  const response = get(`${dird}/backends/wazo/sources`, token, "setup-sources");
  if (response.status !== 200) {
    throw new Error(`wazo sources: HTTP ${response.status}`);
  }
  const sources = response
    .json("items")
    .filter((source) => !sourceName || source.name === sourceName);
  if (sources.length === 0) {
    throw new Error(
      `no wazo source${sourceName ? ` named ${sourceName}` : ""} in tenant ${tenant}`,
    );
  }
  return sources[0].uuid;
}

// Per VU, built on its first iteration
let burst;

export function setup() {
  const runStart = Date.now();
  const expiration = runSeconds + TOKEN_MARGIN_SECONDS;
  const adminToken = createToken(
    engine,
    adminUsername,
    adminPassword,
    expiration,
  ).token;
  const users = listDirectoryUsers(adminToken);
  const extens = users.filter((user) => user.exten).map((user) => user.exten);
  const mobiles = users
    .filter((user) => user.mobile_phone_number)
    .map((user) => user.mobile_phone_number);
  if (extens.length === 0) {
    throw new Error(`no extension to look up in tenant ${tenant}`);
  }
  console.log(
    `tenant ${tenant}: ${users.length} users, ${extens.length} with an ` +
      `extension, ${mobiles.length} with a mobile number`,
  );
  if (users.length < usersExpected) {
    console.warn(
      `${users.length} users, fewer than the ${usersExpected} expected: ` +
        "the cache hit rates will be higher than on a full directory",
    );
  }

  // Each token is one user of the burst model. They all belong to the admin
  // account: wazo-auth sees fewer distinct users than in production
  const tokens = [adminToken];
  while (tokens.length < tokenCount) {
    tokens.push(
      createToken(engine, adminUsername, adminPassword, expiration).token,
    );
  }
  const uuids = users.slice(0, 100).map((user) => user.uuid);

  // dird loads its sources on the first request, and the pool is the same for
  // every VU: the first lookup is not the load
  const source = sourceUuid(adminToken);
  const pool = buildTermPool(extens, mobiles, poolRatio, burstOptions.seed);
  const cold = coldTerm(pool);
  const warm = pool[0];
  checkLookup(
    http.request(...lookupRequest(adminToken, warm, "setup-lookup")),
    warm,
  );

  return {
    runStart,
    tokens,
    uuids,
    source,
    pool,
    cold,
    userCount: users.length,
  };
}

export function teardown({ runStart }) {
  // The monitor holds what k6 cannot see: wazo-dird's own requests to
  // wazo-confd, which a cache must lower
  const matcher = `${stackMatcher()},service="wazo-confd"`;
  const [count, total] = ["count", "sum"].map((stat) => {
    const result = readMonitor(
      `confd ${stat}`,
      runStart,
      (window) =>
        `sum(increase(flask_http_request_duration_seconds_${stat}{${matcher}}[${window}]))`,
    );
    return result?.[0] ? Number(result[0].value[1]) : NaN;
  });
  if (!Number.isNaN(count) && !Number.isNaN(total)) {
    confdRequests.add(count);
    confdServerSeconds.add(total);
    console.log(
      `wazo-confd served ${Math.round(count)} requests in ` +
        `${Math.round(total)} s of server time over the run`,
    );
  }
  checkStackInvariants(runStart);
}

// A burst: the lookups of one user, sent at once
export function lookupBurst({ pool, tokens }) {
  burst ??= createBurstGenerator(pool, burstOptions);
  const { userIndex, entries } = burst(
    exec.scenario.iterationInTest,
    tokens.length,
  );
  const token = tokens[userIndex];
  const responses = http.batch(
    entries.map((entry) => lookupRequest(token, entry, "lookup")),
  );
  responses.forEach((response, i) => checkLookup(response, entries[i]));
}

// Many users asking for the same term nobody has asked for yet
export function stampede({ tokens, cold }) {
  const response = http.batch([lookupRequest(tokens[0], cold, "stampede")])[0];
  checkLookup(response, cold);
}

// The unfiltered listing, as the mobile app sends it: no limit
export function listing({ tokens, source, userCount }) {
  const token = tokens[exec.scenario.iterationInTest % tokens.length];
  const response = get(
    `${dird}/backends/wazo/sources/${source}/contacts?offset=0&order=firstname`,
    token,
    "listing",
  );
  check(response, {
    "listing has every user": (r) =>
      r.status === 200 &&
      r.json("total") >= userCount &&
      r.json("items").length > 0,
  });
}

// Other confd callers: their latency is what dird's load costs them
export function confdProbe({ tokens, uuids }) {
  const iteration = exec.scenario.iterationInTest;
  const token = tokens[0];
  if (iteration % 2 === 0) {
    const uuid = uuids[(iteration / 2) % uuids.length];
    const response = get(`${confd}/users/${uuid}`, token, "confd-user");
    check(response, { "confd user found": (r) => r.status === 200 });
  } else {
    const response = get(`${confd}/users?limit=1`, token, "confd-users-limit1");
    check(response, { "confd users listed": (r) => r.status === 200 });
  }
}
