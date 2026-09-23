// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import encoding from "k6/encoding";
import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const engine = __ENV.WAZO_ENGINE;
const username = __ENV.WAZO_ADMIN_USERNAME;
const password = __ENV.WAZO_ADMIN_PASSWORD;
if (!engine || !username || !password) {
  throw new Error(
    "WAZO_ENGINE, WAZO_ADMIN_USERNAME and WAZO_ADMIN_PASSWORD are required",
  );
}

// nginx gives up on /api/confd/ after 180s while confd keeps working
const confdURL = __ENV.CONFD_URL || `https://${engine}/api/confd`;
const memberCounts = (__ENV.MEMBER_COUNTS || "all")
  .split(",")
  .map((count) => count.trim());
const requestTimeout = __ENV.REQUEST_TIMEOUT || "30m";
const datasetDir = __ENV.DATASET_DIR || "/var/lib/wazo-load-env";

// k6 has no YAML parser; wazo-load-tools writes config.yml as flat keys
const tenantMatch = open(`${datasetDir}/config.yml`).match(
  /^tenant_uuid: *'?([0-9a-f-]+)'?$/m,
);
if (!tenantMatch) {
  throw new Error(`no tenant_uuid in ${datasetDir}/config.yml`);
}
const tenant = tenantMatch[1];

const users = JSON.parse(open(`${datasetDir}/created-users.json`)).created.map(
  (user) => user.user_uuid,
);

for (const count of memberCounts) {
  if (count !== "all" && !(Number(count) > 0)) {
    throw new Error(
      `MEMBER_COUNTS entry "${count}" is neither a positive number nor "all"`,
    );
  }
  if (Number(count) > users.length) {
    throw new Error(
      `MEMBER_COUNTS asks for ${count} members, the dataset has ${users.length}`,
    );
  }
}

const updateDuration = new Trend("group_members_update", true);

export const options = {
  scenarios: {
    members: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: memberCounts.length,
      maxDuration: "4h",
    },
  },
  insecureSkipTLSVerify: true,
  thresholds: Object.fromEntries([
    ["checks", ["rate==1.0"]],
    // a threshold per tag is what makes k6 print each count in the summary
    ...memberCounts.map((count) => [
      `group_members_update{members:${count}}`,
      ["max>=0"],
    ]),
  ]),
};

function request(method, path, token, body, tags) {
  return http.request(
    method,
    `${confdURL}/1.1${path}`,
    body && JSON.stringify(body),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
        "Wazo-Tenant": tenant,
      },
      timeout: requestTimeout,
      tags,
    },
  );
}

export function setup() {
  const credentials = encoding.b64encode(`${username}:${password}`);
  const tokenResponse = http.post(
    `https://${engine}/api/auth/0.1/token`,
    JSON.stringify({ backend: "wazo_user", expiration: 4 * 3600 }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
    },
  );
  if (tokenResponse.status !== 200) {
    throw new Error(`token creation returned ${tokenResponse.status}`);
  }
  return { token: tokenResponse.json("data.token"), runID: Date.now() };
}

export default function (data) {
  const count = memberCounts[exec.scenario.iterationInTest];
  const members = count === "all" ? users : users.slice(0, Number(count));

  const label = `load-members-${count}-${data.runID}`;
  const created = request(
    "POST",
    "/groups",
    data.token,
    { label },
    { name: "create group" },
  );
  if (!check(created, { "group created": (r) => r.status === 201 })) {
    return;
  }

  const path = `/groups/${created.json("uuid")}/members/users`;
  const body = { users: members.map((uuid, priority) => ({ uuid, priority })) };
  const response = request("PUT", path, data.token, body, {
    name: "update group members",
    members: count,
  });
  check(response, { "members updated": (r) => r.status === 204 });
  const duration = response.timings.duration;
  updateDuration.add(duration, { members: count });
  console.log(
    `${label}: ${members.length} members, ${response.status} in ${Math.round(duration)}ms`,
  );
}
