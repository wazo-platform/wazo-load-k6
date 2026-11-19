// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Creates the users that dird-confd-cache-benchmark.js looks up: USERS users
// of one tenant, each with a line, a 5-digit extension and a mobile number,
// through the confd users import (the way 90-confd-users-import.js does it).
// It creates what it needs and cleans nothing up: use a tenant made for the
// test, once.

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

const users = Number(__ENV.USERS || 4500);
const extenBase = Number(__ENV.EXTEN_BASE || 10000);
// 100 users is the size of the import the other benchmark proves
const batchSize = Number(__ENV.BATCH || 100);
if (extenBase < 10000 || extenBase + users > 100000) {
  throw new Error("EXTEN_BASE and USERS must give 5-digit extensions");
}

const confd = `https://${engine}/api/confd/1.1`;
const template = open("../../assets/100entries.csv").trim().split("\n");
const header = splitCsvLine(template[0]);
const templateRows = template.slice(1).map(splitCsvLine);

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    seed: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "3h",
    },
  },
  thresholds: {
    "http_req_duration{name:users-import}": ["max<120000"],
    // An empty metric passes every other threshold
    "http_reqs{name:users-import}": ["count>0"],
    checks: ["rate==1.0"],
  },
};

function splitCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function joinCsvLine(fields) {
  return fields
    .map((field) =>
      /[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field,
    )
    .join(",");
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

// A 10-digit mobile number with its leading 0, distinct for each user
function mobileNumber(index) {
  return `0${600000000 + index * 37}`;
}

// A row of the known-good sample, with what must be unique for each user
function userRow(index, contexts) {
  const row = new Map(
    header.map((column, i) => [column, templateRows[index % 100][i]]),
  );
  const exten = String(extenBase + index);
  row.set("exten", exten);
  row.set("incall_exten", exten);
  row.set("voicemail_number", exten);
  row.set("mobile_phone_number", mobileNumber(index));
  row.set("username", `load${index}`);
  row.set("firstname", "Load");
  row.set("lastname", `User${index}`);
  row.set("sip_username", "");
  row.set("sip_secret", "");
  row.set("context", contexts.internal);
  row.set("voicemail_context", contexts.internal);
  row.set("incall_context", contexts.incall);
  return joinCsvLine(header.map((column) => row.get(column)));
}

export function setup() {
  const token = createToken(engine, adminUsername, adminPassword).token;
  const range = {
    start: String(extenBase),
    end: String(extenBase + users - 1),
  };
  return {
    token,
    contexts: {
      internal: createContext(token, {
        label: "directory-load-internal",
        type: "internal",
        user_ranges: [range],
      }),
      incall: createContext(token, {
        label: "directory-load-incall",
        type: "incall",
        incall_ranges: [range],
      }),
    },
  };
}

export default function ({ token, contexts }) {
  for (let first = 0; first < users; first += batchSize) {
    const count = Math.min(batchSize, users - first);
    const rows = [];
    for (let i = first; i < first + count; i++) {
      rows.push(userRow(i, contexts));
    }
    const response = http.post(
      `${confd}/users/import`,
      [joinCsvLine(header), ...rows].join("\n") + "\n",
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "X-Auth-Token": token,
          "Wazo-Tenant": tenant,
        },
        tags: { name: "users-import" },
        timeout: "180s",
      },
    );
    check(response, {
      "users imported": (r) =>
        r.status === 201 && r.json("created").length === count,
    });
  }
}
