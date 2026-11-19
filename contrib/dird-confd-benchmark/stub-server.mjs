// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Stand-in for the engine, to check that dird-confd-cache-benchmark.js runs end
// to end: wazo-auth, wazo-confd, wazo-dird and a Prometheus, over TLS. Its
// users are those of the load stack: no mobile number, the extension from
// 10000, the index as last name. It proves the script and its metrics, not the
// performance of a real stack.
//   node stub-server.mjs <key.pem> <cert.pem> [port]
// STUB_USERS (default 4500) and STUB_LATENCY_MS (default 20) tune it.

import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

const [keyFile, certFile, portArg] = process.argv.slice(2);
const port = Number(portArg || 8443);
const userCount = Number(process.env.STUB_USERS || 4500);
const latencyMs = Number(process.env.STUB_LATENCY_MS || 20);

const users = Array.from({ length: userCount }, (_, i) => ({
  id: i + 1,
  uuid: randomUUID(),
  firstname: "User",
  lastname: String(i),
  exten: String(10000 + i),
  email: `dev+user${i}@example.com`,
}));
const sourceUuid = randomUUID();
const counts = new Map();
const startedAt = Date.now() / 1000;

function count(key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function reply(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function prometheus(query) {
  const now = Date.now() / 1000;
  if (query.startsWith("min(timestamp(up")) {
    return [{ metric: {}, value: [now, String(now + 5)] }];
  }
  const seconds = query.includes("_sum{");
  if (
    query.includes("flask_http_request_duration_seconds") &&
    query.includes('service="wazo-confd"')
  ) {
    const requests = counts.get("confd") ?? 0;
    const value = seconds ? (requests * latencyMs) / 1000 : requests;
    return [{ metric: {}, value: [now, String(value)] }];
  }
  return [];
}

function route(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const path = url.pathname;
  const params = url.searchParams;

  if (path.endsWith("/api/v1/query")) {
    return reply(response, 200, {
      status: "success",
      data: { result: prometheus(params.get("query") ?? "") },
    });
  }
  if (path === "/api/auth/0.1/token") {
    return reply(response, 200, { data: { token: randomUUID() } });
  }
  if (path === "/api/confd/1.1/users") {
    count("confd");
    const limit = Number(params.get("limit") ?? userCount);
    const offset = Number(params.get("offset") ?? 0);
    return reply(response, 200, {
      total: userCount,
      items: users.slice(offset, offset + limit),
    });
  }
  if (path.startsWith("/api/confd/1.1/users/")) {
    count("confd");
    return reply(response, 200, users[0]);
  }
  if (path === "/api/dird/0.1/backends/wazo/sources") {
    return reply(response, 200, {
      total: 1,
      items: [{ uuid: sourceUuid, name: "wazo-stub" }],
    });
  }
  if (path.startsWith("/api/dird/0.1/directories/lookup/")) {
    count("lookup");
    count("confd");
    const term = params.get("term") ?? "";
    const results = users
      .filter((u) => u.exten.includes(term) || u.lastname.includes(term))
      .slice(0, 20);
    return reply(response, 200, { term, results });
  }
  if (path === `/api/dird/0.1/backends/wazo/sources/${sourceUuid}/contacts`) {
    count("listing");
    count("confd");
    return reply(response, 200, {
      total: userCount,
      filtered: userCount,
      items: users,
    });
  }
  return reply(response, 404, { message: `no stub for ${path}` });
}

const server = createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  (request, response) => {
    setTimeout(
      () => route(request, response),
      latencyMs * (0.5 + Math.random()),
    );
  },
);

function report() {
  console.log(
    `stub served ${JSON.stringify(Object.fromEntries(counts))} in ` +
      `${Math.round(Date.now() / 1000 - startedAt)} s`,
  );
  process.exit(0);
}
process.on("SIGTERM", report);
process.on("SIGINT", report);

server.listen(port, "127.0.0.1", () => {
  console.log(`stub engine on https://127.0.0.1:${port}`);
});
