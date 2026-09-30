// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
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

const dird = `https://${engine}/api/dird/0.1`;

const WARM_UP_REQUESTS = 3;
const DIRD_LOOKUP_SECONDS = 60;
const DIRD_LOOKUP_GRACEFUL_STOP_SECONDS = 5;

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    "dird-lookup": {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: `${DIRD_LOOKUP_SECONDS}s`,
      gracefulStop: `${DIRD_LOOKUP_GRACEFUL_STOP_SECONDS}s`,
      preAllocatedVUs: 10,
      maxVUs: 20,
      exec: "dirdLookup",
    },
    "dird-reverse": {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 10,
      maxVUs: 20,
      startTime: `${DIRD_LOOKUP_SECONDS + DIRD_LOOKUP_GRACEFUL_STOP_SECONDS}s`,
      exec: "dirdReverse",
    },
  },
  // Sized for a 4 vCPU / 16 GiB stack (AWS t3.xlarge)
  thresholds: {
    "http_req_duration{scenario:dird-lookup,name:lookup}": ["p(95)<500"],
    "http_req_duration{scenario:dird-reverse,name:reverse}": ["p(95)<200"],
    // An empty metric passes every other threshold
    "http_reqs{scenario:dird-lookup,name:lookup}": ["count>0"],
    "http_reqs{scenario:dird-reverse,name:reverse}": ["count>0"],
    checks: ["rate==1.0"],
  },
};

function listUsers(token) {
  const response = http.get(
    `https://${engine}/api/confd/1.1/users?view=summary`,
    {
      headers: { "X-Auth-Token": token, "Wazo-Tenant": tenant },
    },
  );
  if (response.status !== 200) {
    throw new Error(`users: HTTP ${response.status}`);
  }
  return response.json("items");
}

function lookup(token, term, name) {
  const query = `term=${encodeURIComponent(term)}`;
  return http.get(`${dird}/directories/lookup/default?${query}`, {
    headers: { "X-Auth-Token": token, "Wazo-Tenant": tenant },
    tags: { name },
  });
}

function reverse(token, userUuid, exten, name) {
  const query = `exten=${encodeURIComponent(exten)}`;
  return http.get(`${dird}/directories/reverse/default/${userUuid}?${query}`, {
    headers: { "X-Auth-Token": token, "Wazo-Tenant": tenant },
    tags: { name },
  });
}

// Round-robin rather than random: every run sends the same requests, so
// runs compare alike
function nextItem(items) {
  return items[exec.scenario.iterationInTest % items.length];
}

export function setup() {
  const token = createToken(engine, adminUsername, adminPassword).token;
  const users = listUsers(token);
  if (users.length === 0) {
    throw new Error(`no users to look up in tenant ${tenant}`);
  }
  // Lookup matches the term within every column, so on the load dataset,
  // named by number, a shorter last name matches hundreds of extensions
  const terms = users
    .map((user) => user.lastname)
    .filter((lastname) => /^\d{4}$/.test(lastname))
    .sort();
  if (terms.length === 0) {
    throw new Error(`no 4-digit last name to look up in tenant ${tenant}`);
  }
  const extens = users
    .filter((user) => user.extension)
    .map((user) => user.extension)
    .sort();
  if (extens.length === 0) {
    throw new Error(`no extension to reverse look up in tenant ${tenant}`);
  }
  const userUuid = users[0].uuid;

  // dird loads its sources on the first requests: done here, it is over
  // before the load starts, which an arrival rate does not wait for
  for (let i = 0; i < WARM_UP_REQUESTS; i++) {
    lookup(token, terms[i % terms.length], "warm-up");
    reverse(token, userUuid, extens[i % extens.length], "warm-up");
  }

  return { token, userUuid, terms, extens };
}

export function dirdLookup({ token, terms }) {
  const response = lookup(token, nextItem(terms), "lookup");
  check(response, {
    "lookup found results": (r) =>
      r.status === 200 && r.json("results").length > 0,
  });
}

export function dirdReverse({ token, userUuid, extens }) {
  const response = reverse(token, userUuid, nextItem(extens), "reverse");
  check(response, {
    "reverse found a user": (r) =>
      r.status === 200 && r.json("display") !== null,
  });
}
