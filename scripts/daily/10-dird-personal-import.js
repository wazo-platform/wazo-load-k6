// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

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

const contactsCsv = open("../../assets/1000contacts.csv");
const benchmarkUser = "dird-personal-import-benchmark";

export const options = {
  insecureSkipTLSVerify: true,
  vus: 1,
  iterations: 1,
  // Sized for a 4 vCPU / 16 GiB stack (AWS t3.xlarge)
  thresholds: {
    "http_req_duration{name:personal-import}": ["max<5000"],
    // An empty metric passes every other threshold
    "http_reqs{name:personal-import}": ["count>0"],
    checks: ["rate==1.0"],
  },
};

function createUser(token, username, password) {
  const body = JSON.stringify({ username, password });
  const response = http.post(`https://${engine}/api/auth/0.1/users`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
      "Wazo-Tenant": tenant,
    },
  });
  if (response.status !== 200) {
    throw new Error(`user ${username}: HTTP ${response.status}`);
  }
}

export function setup() {
  const adminToken = createToken(engine, adminUsername, adminPassword).token;
  createUser(adminToken, benchmarkUser, benchmarkUser);
  return { token: createToken(engine, benchmarkUser, benchmarkUser).token };
}

export default function ({ token }) {
  const response = http.post(
    `https://${engine}/api/dird/0.1/personal/import`,
    contactsCsv,
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "X-Auth-Token": token,
      },
      tags: { name: "personal-import" },
    },
  );
  check(response, {
    "1000 contacts imported": (r) =>
      r.status === 201 && r.json("created").length === 1000,
  });
}
