// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Replays the requests the mobile app sends when a session opens, as
// tools/har-login.mjs extracted them from a capture, with the session's own
// identifiers in place of the recorded ones.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { setTimeout } from "k6/timers";
import { callPeers } from "./call-peers.js";

const steps = JSON.parse(open("../assets/mobile-login.json"));

// A step the target stack has no value for, such as a directory backend it
// does not configure or a call history shorter than the recorded one
const skipped = new Counter("mobile_login_skipped");

// A recorded failure, such as a 404 from a directory backend the captured
// user had not connected, is a success for a user who has
const SUCCESS = { min: 200, max: 299 };

const PLACEHOLDER = /\{([a-z_]+?)(?:_(\d+))?\}/g;
const BACKEND = /\/backends\/([^/]+)\//;

// A session holds its values until it ends: on a large tenant the whole
// directory per session would exhaust the load generator
const contactsUsed = Math.max(
  0,
  ...steps.flatMap((step) =>
    [
      ...`${step.path} ${step.body ?? ""}`.matchAll(/\{contact_uuid_(\d+)\}/g),
    ].map(([, index]) => Number(index) + 1),
  ),
);

const extractors = {
  line_id: (body) => body.lines[0]?.id,
  sources: (body) => body.items,
  peers: (body, user) => callPeers(body, user.uuid),
  contacts: (body, user) =>
    body.items
      .filter((contact) => contact.uuid !== user.uuid)
      .slice(0, contactsUsed)
      .map((contact) => ({ uuid: contact.uuid })),
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function value(session, name, index, path) {
  const { values, user } = session;
  switch (name) {
    case "user_uuid":
      return user.uuid;
    case "push_token":
      return session.pushToken;
    case "line_id":
      return values.line_id.promise;
    case "source_uuid": {
      const backend = BACKEND.exec(path)[1];
      const sources = await values.sources.promise;
      return sources?.find((source) => source.backend === backend)?.uuid;
    }
    case "peer_uuid":
      return (await values.peers.promise)?.[index]?.uuid;
    case "peer_number":
      return (await values.peers.promise)?.[index]?.number;
    case "contact_uuid":
      return (await values.contacts.promise)?.[index]?.uuid;
  }
  throw new Error(`mobile login: unknown placeholder {${name}}`);
}

// null when one of the values is missing on the target stack
async function fill(template, session, path) {
  let filled = template;
  for (const [placeholder, name, index] of template.matchAll(PLACEHOLDER)) {
    const found = await value(session, name, Number(index), path);
    if (found === null || found === undefined) return null;
    filled = filled.replace(placeholder, String(found));
  }
  return filled;
}

async function play(step, session) {
  const path = await fill(step.path, session, step.path);
  const body = step.body ? await fill(step.body, session, step.path) : null;
  if (path === null || (step.body && body === null)) {
    skipped.add(1, { name: step.path });
    session.values[step.provides]?.resolve(null);
    return;
  }
  const response = await http.asyncRequest(
    step.method,
    `https://${session.engine}${path}`,
    body,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": session.user.token,
      },
      tags: { name: step.path },
      // a body the replay does not read would only fill the load generator
      responseType: step.provides ? "text" : "none",
      responseCallback: http.expectedStatuses(SUCCESS, step.status),
    },
  );
  check(response, {
    "mobile login status as recorded or success": (r) =>
      r.status === step.status || (r.status >= 200 && r.status < 300),
  });
  if (step.provides) {
    const ok = response.status === 200;
    session.values[step.provides].resolve(
      ok ? extractors[step.provides](response.json(), session.user) : null,
    );
  }
}

// onWebsocket opens wazo-websocketd at the moment the app did
export function playLogin(engine, user, pushToken, onWebsocket) {
  const session = { engine, user, pushToken, values: {} };
  for (const step of steps) {
    if (step.provides) session.values[step.provides] = deferred();
  }
  for (const step of steps) {
    const run = step.websocket ? onWebsocket : () => play(step, session);
    setTimeout(run, step.at * 1000);
  }
}
