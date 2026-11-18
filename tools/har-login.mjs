// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Extracts the requests the mobile app sends when a session opens, from a
// HAR capture, as the steps modules/mobile-login.js replays.
//
//   node tools/har-login.mjs --host <name> <capture.har> > assets/mobile-login.json
//
// Every recorded identifier becomes a placeholder filled at replay time from
// the session's own token or from an earlier response. One the script cannot
// trace back to its source stops the extraction: the app depends on a value
// the replay does not know how to fill yet.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { callPeers } from "../modules/call-peers.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUMBER_SEGMENT = /\/\d+(\/|$)/;
const OPAQUE = /(?=[\w-]*\d)[\w-]{16,}/;

const TOKEN_PATH = "/api/auth/0.1/token";
const PUSH_PATH = /\/external\/mobile$/;
const SOURCES_PATH = "/api/dird/0.1/directories/default/sources";
const WAZO_CONTACTS_PATH = /\/backends\/wazo\/sources\/[^/]+\/contacts$/;

// RegExp.escape needs Node 24
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function responseJson(entry) {
  return JSON.parse(entry.response.content.text);
}

// Sessions run from one token creation to the next
function sessions(entries) {
  const found = [];
  for (const entry of entries) {
    const url = new URL(entry.request.url);
    if (entry.request.method === "POST" && url.pathname === TOKEN_PATH) {
      found.push({ login: entry, entries: [] });
    } else if (found.length > 0) {
      found.at(-1).entries.push(entry);
    }
  }
  return found;
}

// Setup registers every push token beforehand: each replayed session finds
// its mobile auth already there, as in a session whose POST got a 409
function pickSession(all) {
  const session = all.find(({ entries }) =>
    entries.some(
      (entry) =>
        entry.request.method === "POST" &&
        PUSH_PATH.test(new URL(entry.request.url).pathname) &&
        entry.response.status === 409,
    ),
  );
  if (!session) {
    throw new Error("no session registers a push token already registered");
  }
  return session;
}

function header(entry, name) {
  return entry.request.headers.find((h) => h.name.toLowerCase() === name)
    ?.value;
}

// The values the replay fills, as recorded, and the step that provides each.
// A value several responses hold is credited to the latest one before the
// request, as the app reads it from there.
class Values {
  constructor(login) {
    const token = responseJson(login).data;
    this.token = token.token;
    this.userUuid = token.metadata.uuid;
    this.known = [];
    this.remember(this.userUuid, "{user_uuid}");
    this.lineLearned = false;
  }

  remember(literal, placeholder) {
    if (literal) this.known.unshift({ literal, placeholder });
  }

  rememberNumber(number, placeholder) {
    if (number) {
      this.known.unshift({
        literal: `=${number}`,
        placeholder: `=${placeholder}`,
      });
    }
  }

  learn(entry, step) {
    const { pathname } = new URL(entry.request.url);
    if (!this.lineLearned && pathname.endsWith(`/users/${this.userUuid}`)) {
      const lineId = responseJson(entry).lines[0].id;
      this.remember(`/lines/${lineId}`, "/lines/{line_id}");
      this.lineLearned = true;
      step.provides = "line_id";
    } else if (pathname === SOURCES_PATH) {
      for (const source of responseJson(entry).items) {
        this.remember(source.uuid, "{source_uuid}");
      }
      step.provides = "sources";
    } else if (pathname.endsWith("/users/me/cdr")) {
      callPeers(responseJson(entry), this.userUuid).forEach((peer, index) => {
        this.remember(peer.uuid, `{peer_uuid_${index}}`);
        this.rememberNumber(peer.number, `{peer_number_${index}}`);
      });
      step.provides = "peers";
    } else if (WAZO_CONTACTS_PATH.test(pathname)) {
      responseJson(entry)
        .items.filter((contact) => contact.uuid !== this.userUuid)
        .forEach((contact, index) => {
          this.remember(contact.uuid, `{contact_uuid_${index}}`);
        });
      step.provides = "contacts";
    }
  }

  template(text) {
    let result = text;
    for (const { literal, placeholder } of this.known) {
      result = result.replace(
        new RegExp(`${escapeRegExp(literal)}(?=$|[&,/"])`, "g"),
        placeholder,
      );
    }
    return result;
  }
}

function unknownValue(text) {
  const pathname = text.split("?")[0];
  return (
    UUID.exec(text)?.[0] ??
    NUMBER_SEGMENT.exec(pathname)?.[0] ??
    OPAQUE.exec(text)?.[0]
  );
}

function step(entry, values, start) {
  const url = new URL(entry.request.url);
  const at = (Date.parse(entry.startedDateTime) - start) / 1000;
  if (url.pathname === "/api/websocketd/") {
    return { at, websocket: true };
  }
  const { method } = entry.request;
  const recordedBody = entry.request.postData?.text;
  if (recordedBody && PUSH_PATH.test(url.pathname)) {
    values.remember(JSON.parse(recordedBody).token, "{push_token}");
  }
  const result = {
    at,
    method,
    path: values.template(decodeURIComponent(url.pathname + url.search)),
    status: entry.response.status,
  };
  if (recordedBody) {
    result.body = values.template(recordedBody);
  }
  const unknown = unknownValue(result.path) ?? unknownValue(result.body ?? "");
  if (unknown) {
    throw new Error(`${method} ${result.path}: unknown value ${unknown}`);
  }
  values.learn(entry, result);
  return result;
}

function isSession(entry, values) {
  const { pathname, searchParams } = new URL(entry.request.url);
  if (pathname === "/api/websocketd/") {
    return searchParams.get("token") === values.token;
  }
  return header(entry, "x-auth-token") === values.token;
}

function loginSteps(entries) {
  const session = pickSession(sessions(entries));
  const values = new Values(session.login);
  const start = Date.parse(session.login.startedDateTime);
  const steps = [];
  for (const entry of session.entries) {
    if (new URL(entry.request.url).pathname === "/api/asterisk/ws") break;
    if (isSession(entry, values)) steps.push(step(entry, values, start));
  }
  return steps;
}

function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { host: { type: "string" } },
  });
  if (!values.host || positionals.length !== 1) {
    console.error("usage: har-login.mjs --host <name> <capture.har>");
    process.exitCode = 2;
    return;
  }
  const entries = JSON.parse(readFileSync(positionals[0], "utf8"))
    .log.entries.filter(
      (entry) => new URL(entry.request.url).hostname === values.host,
    )
    .sort(
      (a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime),
    );
  console.log(JSON.stringify(loginSteps(entries), null, 2));
}

main(process.argv.slice(2));
