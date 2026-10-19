// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Lookups and contact listings against Google accounts served by the Google
// People API mock that run-load-k6-script installs on the stack: wazo-dird
// downloads each account's contacts from it on the first request, then serves
// its cache. Needs the ITEM-811 branches of wazo-dird, which trust the mock.

import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
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

const mockUrl = __ENV.GOOGLE_MOCK_URL || `http://${engine}:8090`;
const contactsPerUser = Number(__ENV.GOOGLE_CONTACTS || 1000);
const pageDelayMs = Number(__ENV.GOOGLE_PAGE_DELAY_MS || 0);
const users = Number(__ENV.USERS || 20);
const lookupRate = Number(__ENV.LOOKUP_RATE || 10);
const lookupSeconds = Number(__ENV.LOOKUP_SECONDS || 60);
const listRate = Number(__ENV.LIST_RATE || 10);
const listSeconds = Number(__ENV.LIST_SECONDS || 60);
const pageSize = Number(__ENV.PAGE_SIZE || 50);

const dird = `https://${engine}/api/dird/0.1`;
const userPassword = "dird-google-contacts-load";

const WARM_UP_REQUESTS = 3;
const GRACEFUL_STOP_SECONDS = 5;
// The users' tokens must outlive the run and its setup
const TOKEN_EXPIRATION_SECONDS =
  lookupSeconds + GRACEFUL_STOP_SECONDS + listSeconds + 600;

const pages = Math.ceil(contactsPerUser / pageSize);

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    "google-lookup": {
      executor: "constant-arrival-rate",
      rate: lookupRate,
      timeUnit: "1s",
      duration: `${lookupSeconds}s`,
      gracefulStop: `${GRACEFUL_STOP_SECONDS}s`,
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: "googleLookup",
    },
    "google-contacts": {
      executor: "constant-arrival-rate",
      rate: listRate,
      timeUnit: "1s",
      duration: `${listSeconds}s`,
      preAllocatedVUs: 10,
      maxVUs: 50,
      startTime: `${lookupSeconds + GRACEFUL_STOP_SECONDS}s`,
      exec: "googleContacts",
    },
  },
  thresholds: {
    // A lookup downloads the account's contacts when they are not cached yet
    "http_req_duration{scenario:google-lookup,name:lookup}": ["p(95)<1000"],
    "http_req_duration{scenario:google-contacts,name:contacts}": ["p(95)<500"],
    // An empty metric passes every other threshold
    "http_reqs{scenario:google-lookup,name:lookup}": ["count>0"],
    "http_reqs{scenario:google-contacts,name:contacts}": ["count>0"],
    checks: ["rate==1.0"],
    monitor_checks: ["rate==1.0"],
  },
};

function configureMock() {
  const body = JSON.stringify({
    contacts_per_user: contactsPerUser,
    page_delay_ms: pageDelayMs,
  });
  const response = http.put(`${mockUrl}/_mock/config`, body, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "mock-config" },
  });
  if (response.status !== 200) {
    throw new Error(`Google mock ${mockUrl}: HTTP ${response.status}`);
  }
}

function mockStats() {
  const response = http.get(`${mockUrl}/_mock/stats`, {
    tags: { name: "mock-stats" },
  });
  if (response.status !== 200) {
    throw new Error(`Google mock ${mockUrl}: HTTP ${response.status}`);
  }
  return response.json();
}

function googleSourceUuid(token) {
  const response = http.get(`${dird}/backends/google/sources`, {
    headers: { "X-Auth-Token": token, "Wazo-Tenant": tenant },
  });
  if (response.status !== 200) {
    throw new Error(`google sources: HTTP ${response.status}`);
  }
  const sources = response.json("items");
  if (sources.length === 0) {
    throw new Error(`no google source in tenant ${tenant}`);
  }
  return sources[0].uuid;
}

// A user left by a previous run on the same stack is reused
function createUser(token, username, password) {
  const body = JSON.stringify({ username, password });
  const response = http.post(`https://${engine}/api/auth/0.1/users`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
      "Wazo-Tenant": tenant,
    },
  });
  if (response.status !== 200 && response.status !== 409) {
    throw new Error(`user ${username}: HTTP ${response.status}`);
  }
}

// The mock names its contacts Load00000, Load00001, ... so each term matches
// one contact of the account
function term(index) {
  return `Load${String(index % contactsPerUser).padStart(5, "0")}`;
}

function lookup(token, term, name) {
  const query = `term=${encodeURIComponent(term)}`;
  return http.get(`${dird}/directories/lookup/default?${query}`, {
    headers: { "X-Auth-Token": token },
    tags: { name },
  });
}

function listContacts(token, sourceUuid, offset, name) {
  const query = `limit=${pageSize}&offset=${offset}&order=name&direction=asc`;
  return http.get(
    `${dird}/backends/google/sources/${sourceUuid}/contacts?${query}`,
    {
      headers: { "X-Auth-Token": token },
      tags: { name },
    },
  );
}

export function setup() {
  const runStart = Date.now();
  configureMock();
  const adminToken = createToken(engine, adminUsername, adminPassword).token;
  const sourceUuid = googleSourceUuid(adminToken);

  // One Google account per user: the mock holds the same contacts for every
  // token, but wazo-dird downloads and caches them once per token
  const tokens = [];
  for (let i = 0; i < users; i++) {
    const username = `dird-google-contacts-load-${i}`;
    createUser(adminToken, username, userPassword);
    tokens.push(
      createToken(engine, username, userPassword, TOKEN_EXPIRATION_SECONDS)
        .token,
    );
  }

  // dird loads its sources on the first requests: done here, it is over
  // before the load starts, which an arrival rate does not wait for
  for (let i = 0; i < WARM_UP_REQUESTS; i++) {
    lookup(tokens[0], term(i), "warm-up");
  }

  return { runStart, sourceUuid, tokens };
}

export function teardown({ runStart }) {
  const stats = mockStats();
  console.log(
    `the Google mock served ${stats.page_requests} pages to ${stats.accounts} accounts`,
  );
  checkStackInvariants(runStart);
}

// Round-robin over the users, then the terms or pages, rather than random:
// every run sends the same requests, so runs compare alike
function user(tokens) {
  return tokens[exec.scenario.iterationInTest % tokens.length];
}

export function googleLookup({ tokens }) {
  const iteration = exec.scenario.iterationInTest;
  const response = lookup(
    user(tokens),
    term(Math.floor(iteration / tokens.length)),
    "lookup",
  );
  check(response, {
    "lookup found the Google contact": (r) =>
      r.status === 200 &&
      r.json("results").some((result) => result.backend === "google"),
  });
}

export function googleContacts({ tokens, sourceUuid }) {
  const iteration = exec.scenario.iterationInTest;
  const page = Math.floor(iteration / tokens.length) % pages;
  const offset = page * pageSize;
  const expected = Math.min(pageSize, contactsPerUser - offset);
  const response = listContacts(user(tokens), sourceUuid, offset, "contacts");
  check(response, {
    "contacts page is full": (r) =>
      r.status === 200 &&
      r.json("total") === contactsPerUser &&
      r.json("items").length === expected,
  });
}
