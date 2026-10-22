// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import { Counter } from "k6/metrics";

const apiRequests = new Counter("api_requests");

const uuidSegment =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numberSegment = /^\d+$/;
// a name made unique per session, such as a token's client id
const numberSuffix = /-\d+$/;

// What a browser page asks of the engine's REST APIs, by workflow step. CORS
// preflights count: the engine answers them like any other request.
export function recordApiRequests(page, engine) {
  const prefix = `https://${engine}/api/`;
  const routes = new Map();
  let currentStep = "start";

  function record(request, status) {
    const url = request.url();
    if (!url.startsWith(prefix)) {
      return;
    }
    const { service, route } = parseRoute(url.slice(prefix.length));
    const method = request.method();
    apiRequests.add(1, { step: currentStep, service, route, method, status });

    const key = `${currentStep} ${method} ${service} ${route}`;
    if (!routes.has(key)) {
      routes.set(key, {
        step: currentStep,
        method,
        service,
        route,
        statuses: {},
      });
    }
    const entry = routes.get(key);
    entry.statuses[status] = (entry.statuses[status] || 0) + 1;
  }

  page.on("response", (response) => {
    record(response.request(), String(response.status()));
  });
  // a timeout or a request the browser blocked, such as on CORS, gets no
  // response but was still asked for; the browser also reports as aborted
  // some requests it already got a response for, counted there already
  page.on("requestfailed", async (request) => {
    if (await request.response()) {
      return;
    }
    record(request, `failed ${request.failure().errorText}`);
  });

  return {
    step(name) {
      currentStep = name;
    },
    // in the order each route was first requested
    capture() {
      return [...routes.values()];
    },
  };
}

// ids and query values vary per user: the route is what the app asked for
function parseRoute(path) {
  const [pathname, query] = path.split("?");
  const [service, ...segments] = pathname.split("/");
  const route = segments.map(normalizeSegment).join("/");
  const parameters = query
    ? [...new Set(query.split("&").map((pair) => pair.split("=")[0]))]
    : [];
  const suffix = parameters.length ? `?${parameters.sort().join("&")}` : "";
  return { service, route: `/${route}${suffix}` };
}

function normalizeSegment(segment) {
  if (uuidSegment.test(segment) || numberSegment.test(segment)) {
    return "{id}";
  }
  return segment.replace(numberSuffix, "-{id}");
}
