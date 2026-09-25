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

const confd = `https://${engine}/api/confd/1.1`;
const dird = `https://${engine}/api/dird/0.1`;

const CONFD_USERS_IMPORT_MAX_DURATION = "2m";

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    "confd-users-import": {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: CONFD_USERS_IMPORT_MAX_DURATION,
      exec: "confdUsersImport",
    },
    "dird-personal-import": {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      startTime: CONFD_USERS_IMPORT_MAX_DURATION,
      maxDuration: "30s",
      exec: "dirdPersonalImport",
    },
  },
  // Sized for a 4 vCPU / 16 GiB stack (AWS t3.xlarge)
  thresholds: {
    "http_req_duration{scenario:confd-users-import,name:users-import}": [
      "max<60000",
    ],
    "http_req_duration{scenario:dird-personal-import,name:personal-import}": [
      "max<5000",
    ],
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
  return response.json("data.token");
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

export function setup() {
  const token = createToken(adminUsername, adminPassword);
  const internalContext = createContext(token, {
    label: "confd-users-import-internal",
    type: "internal",
    user_ranges: [{ start: "6000", end: "6099" }],
  });
  const incallContext = createContext(token, {
    label: "confd-users-import-incall",
    type: "incall",
    incall_ranges: [{ start: "6000", end: "6099" }],
  });
  return { token, internalContext, incallContext };
}

export function confdUsersImport({ token, internalContext, incallContext }) {
  const body = usersCsv
    .replaceAll("INTERNAL_CONTEXT", internalContext)
    .replaceAll("INCALL_CONTEXT", incallContext);
  const usersResponse = http.post(`${confd}/users/import`, body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "X-Auth-Token": token,
      "Wazo-Tenant": tenant,
    },
    tags: { name: "users-import" },
    timeout: "90s",
  });
  check(usersResponse, {
    "100 users imported": (r) =>
      r.status === 201 && r.json("created").length === 100,
  });
}

export function dirdPersonalImport() {
  const userToken = createToken(users[0].username, users[0].password);
  const contactsResponse = http.post(`${dird}/personal/import`, contactsCsv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "X-Auth-Token": userToken,
    },
    tags: { name: "personal-import" },
  });
  check(contactsResponse, {
    "1000 contacts imported": (r) =>
      r.status === 201 && r.json("created").length === 1000,
  });
}
