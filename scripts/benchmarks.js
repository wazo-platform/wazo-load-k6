// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import csv from "k6/experimental/csv";
import { open as openFile } from "k6/experimental/fs";
import encoding from "k6/encoding";
import http from "k6/http";
import { check } from "k6";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
const tenant = __ENV.WAZO_TENANT;
if (!engine || !adminUsername || !adminPassword || !tenant) {
  throw new Error(
    "WAZO_ENGINE, WAZO_ADMIN_USERNAME, WAZO_ADMIN_PASSWORD and WAZO_TENANT are required",
  );
}

const usersCsv = open("../assets/100entries.csv");
const contactsCsv = open("../assets/1000contacts.csv");
const users = await csv.parse(await openFile("../assets/100entries.csv"), {
  asObjects: true,
});
const contacts = await csv.parse(await openFile("../assets/1000contacts.csv"), {
  asObjects: true,
});

const confd = `https://${engine}/api/confd/1.1`;
const dird = `https://${engine}/api/dird/0.1`;

const WARM_UP_REQUESTS = 3;
const DIRD_LOOKUP_SECONDS = 60;
const DIRD_LOOKUP_GRACEFUL_STOP_SECONDS = 5;

export const options = {
  insecureSkipTLSVerify: true,
  setupTimeout: "2m",
  scenarios: {
    "dird-lookup": {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: `${DIRD_LOOKUP_SECONDS}s`,
      gracefulStop: `${DIRD_LOOKUP_GRACEFUL_STOP_SECONDS}s`,
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "dirdLookup",
    },
    "dird-reverse": {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 5,
      maxVUs: 20,
      startTime: `${DIRD_LOOKUP_SECONDS + DIRD_LOOKUP_GRACEFUL_STOP_SECONDS}s`,
      exec: "dirdReverse",
    },
  },
  // Sized for a 4 vCPU / 16 GiB stack (AWS t3.xlarge)
  thresholds: {
    "http_req_duration{name:users-import}": ["max<60000"],
    "http_req_duration{name:personal-import}": ["max<5000"],
    "http_req_duration{scenario:dird-lookup,name:lookup}": ["p(95)<500"],
    "http_req_duration{scenario:dird-reverse,name:reverse}": ["p(95)<200"],
    checks: ["rate==1.0"],
  },
};

function createToken(username, password) {
  const credentials = encoding.b64encode(`${username}:${password}`);
  const body = JSON.stringify({ backend: "wazo_user", expiration: 600 });
  const response = http.post(`https://${engine}/api/auth/0.1/token`, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
  });
  if (response.status !== 200) {
    throw new Error(`token for ${username}: HTTP ${response.status}`);
  }
  return response.json("data");
}

function createContext(token, body) {
  const response = http.post(`${confd}/contexts`, JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
      "Wazo-Tenant": tenant,
    },
  });
  if (response.status !== 201) {
    throw new Error(`context ${body.label}: HTTP ${response.status}`);
  }
  return response.json("name");
}

function listUsers(token) {
  const response = http.get(`${confd}/users?view=summary`, {
    headers: { "X-Auth-Token": token, "Wazo-Tenant": tenant },
  });
  if (response.status !== 200) {
    throw new Error(`users: HTTP ${response.status}`);
  }
  return response.json("items");
}

function importUsers(token) {
  const internalContext = createContext(token, {
    label: "benchmarks-internal",
    type: "internal",
    user_ranges: [{ start: "6000", end: "6099" }],
  });
  const incallContext = createContext(token, {
    label: "benchmarks-incall",
    type: "incall",
    incall_ranges: [{ start: "6000", end: "6099" }],
  });
  const body = usersCsv
    .replaceAll("INTERNAL_CONTEXT", internalContext)
    .replaceAll("INCALL_CONTEXT", incallContext);
  const response = http.post(`${confd}/users/import`, body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "X-Auth-Token": token,
      "Wazo-Tenant": tenant,
    },
    tags: { name: "users-import" },
    timeout: "90s",
  });
  check(response, {
    "100 users imported": (r) =>
      r.status === 201 && r.json("created").length === 100,
  });
}

function importPersonalContacts(token) {
  const response = http.post(`${dird}/personal/import`, contactsCsv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "X-Auth-Token": token,
    },
    tags: { name: "personal-import" },
  });
  check(response, {
    "1000 contacts imported": (r) =>
      r.status === 201 && r.json("created").length === 1000,
  });
}

function lookup(token, term, name) {
  const query = `term=${encodeURIComponent(term)}`;
  return http.get(`${dird}/directories/lookup/default?${query}`, {
    headers: { "X-Auth-Token": token },
    tags: { name },
  });
}

function reverse(token, userUuid, exten, name) {
  const query = `exten=${encodeURIComponent(exten)}`;
  return http.get(`${dird}/directories/reverse/default/${userUuid}?${query}`, {
    headers: { "X-Auth-Token": token },
    tags: { name },
  });
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function setup() {
  const adminToken = createToken(adminUsername, adminPassword).token;
  importUsers(adminToken);

  const user = createToken(users[0].username, users[0].password);
  importPersonalContacts(user.token);

  const stackUsers = listUsers(adminToken);
  const terms = [
    ...contacts.map((contact) => contact.lastname),
    ...users.map((row) => row.lastname),
    ...stackUsers.map((row) => `${row.firstname} ${row.lastname}`),
  ];
  const extens = [
    ...contacts.map((contact) => contact.number),
    ...users.map((row) => row.exten),
    ...stackUsers.filter((row) => row.extension).map((row) => row.extension),
  ];

  // The first requests fill the dird caches and token checks
  for (let i = 0; i < WARM_UP_REQUESTS; i++) {
    lookup(user.token, randomItem(terms), "warm-up");
    reverse(adminToken, user.metadata.uuid, randomItem(extens), "warm-up");
  }

  return {
    adminToken,
    userToken: user.token,
    userUuid: user.metadata.uuid,
    terms,
    extens,
  };
}

export function dirdLookup({ userToken, terms }) {
  const response = lookup(userToken, randomItem(terms), "lookup");
  check(response, {
    "lookup found results": (r) =>
      r.status === 200 && r.json("results").length > 0,
  });
}

export function dirdReverse({ adminToken, userUuid, extens }) {
  const response = reverse(adminToken, userUuid, randomItem(extens), "reverse");
  check(response, {
    "reverse found a contact": (r) =>
      r.status === 200 && r.json("display") !== null,
  });
}
