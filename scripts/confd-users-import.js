// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import http from "k6/http";
import { check } from "k6";
import { createToken } from "../modules/wazo.js";

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
const confd = `https://${engine}/api/confd/1.1`;

export const options = {
  insecureSkipTLSVerify: true,
  vus: 1,
  iterations: 1,
  // Sized for a 4 vCPU / 16 GiB stack (AWS t3.xlarge)
  thresholds: {
    "http_req_duration{name:users-import}": ["max<60000"],
    // An empty metric passes every other threshold
    "http_reqs{name:users-import}": ["count>0"],
    checks: ["rate==1.0"],
  },
};

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
  const token = createToken(engine, adminUsername, adminPassword).token;
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

export default function ({ token, internalContext, incallContext }) {
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
