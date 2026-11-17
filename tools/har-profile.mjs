// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Profiles the traffic of a HAR capture, websocket frames included
// (`_webSocketMessages`, as Chrome and mitmproxy write them).
//
//   node tools/har-profile.mjs profile <capture.har>
//   node tools/har-profile.mjs diff <old.har> <new.har>
//   node tools/har-profile.mjs subscriptions <capture.har>
//
// --host <name> keeps only that host's traffic: a device capture also holds
// what the OS and other apps send.
// --ratio <n> (diff, default 1.5): smaller changes are left out, since two
// captures of the same app version already differ by about 10%.
//
// profile: how many times each kind of message was sent or received.
// diff: what changed between two captures, as a Markdown table.
// subscriptions: the events subscribed on wazo-websocketd, as JSON
// (the format of assets/mobile-websocket-events.json).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;
// Tokens, hashes and other opaque identifiers in a path
const OPAQUE = /^(?=.*\d)[\w.@%+-]{16,}$/;

function pathTemplate(pathname) {
  return pathname
    .split("/")
    .map((segment) => {
      if (UUID.test(segment)) return "{uuid}";
      if (NUMBER.test(segment)) return "{id}";
      if (OPAQUE.test(segment)) return "{opaque}";
      return segment;
    })
    .join("/");
}

function requestKey(method, rawUrl) {
  const url = new URL(rawUrl);
  const params = [...new Set(url.searchParams.keys())].sort();
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${method} ${url.host}${pathTemplate(url.pathname)}${query}`;
}

// SIP over websocket: a request line or a status line, then a CSeq header
function sipKey(text) {
  const [firstLine] = text.split("\r\n", 1);
  const cseq = /^CSeq:\s*\d+\s+(\w+)/im.exec(text)?.[1] ?? "?";
  const status = /^SIP\/2\.0 (\d{3})/.exec(firstLine);
  if (status) return `sip ${status[1]} ${cseq}`;
  const request = /^([A-Z]+) \S+ SIP\/2\.0/.exec(firstLine);
  return request ? `sip ${request[1]}` : null;
}

function wazoKey(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof message?.op !== "string") return null;
  if (message.op === "subscribe" && message.data?.event_name) {
    return `subscribe ${message.data.event_name}`;
  }
  if (message.op === "event" && message.data?.name) {
    return `event ${message.data.name}`;
  }
  return message.op;
}

function frameKey(frame) {
  // opcode 1 is text, as in RFC 6455
  if (frame.opcode !== 1) return "binary";
  if (frame.data.trim() === "") return "keepalive";
  return sipKey(frame.data) ?? wazoKey(frame.data) ?? "text";
}

function* messageKeys(entry) {
  const { method, url } = entry.request;
  yield requestKey(method, url);
  const frames = entry._webSocketMessages ?? [];
  const socket = pathTemplate(new URL(url).pathname);
  for (const frame of frames) {
    yield `ws ${socket} ${frame.type} ${frameKey(frame)}`;
  }
}

function profile(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const key of messageKeys(entry)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return new Map([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function subscriptions(entries) {
  const events = new Set();
  for (const entry of entries) {
    for (const frame of entry._webSocketMessages ?? []) {
      if (frame.type !== "send" || frame.opcode !== 1) continue;
      const key = wazoKey(frame.data);
      if (key?.startsWith("subscribe ")) events.add(key.slice(10));
    }
  }
  return [...events];
}

function diff(before, after, ratio) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const rows = keys
    .map((key) => [key, before.get(key) ?? 0, after.get(key) ?? 0])
    .filter(([, old, now]) => {
      if (old === 0 || now === 0) return old !== now;
      return now / old >= ratio || old / now >= ratio;
    })
    .map(([key, old, now]) => {
      let change = `×${(now / old).toFixed(1)}`;
      if (old === 0) change = "new";
      if (now === 0) change = "gone";
      return `| \`${key}\` | ${old} | ${now} | ${change} |`;
    });
  return [
    "| Message | Before | After | Change |",
    "|---|---|---|---|",
    ...rows,
  ];
}

function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      ratio: { type: "string", default: "1.5" },
    },
  });
  const [command, ...paths] = positionals;
  const readHar = (path) => {
    const entries = JSON.parse(readFileSync(path, "utf8")).log.entries;
    if (!values.host) return entries;
    return entries.filter(
      (entry) => new URL(entry.request.url).hostname === values.host,
    );
  };
  switch (command) {
    case "profile":
      for (const [key, count] of profile(readHar(paths[0]))) {
        console.log(`${String(count).padStart(6)}  ${key}`);
      }
      break;
    case "diff": {
      const [before, after] = paths.map((path) => profile(readHar(path)));
      console.log(diff(before, after, Number(values.ratio)).join("\n"));
      break;
    }
    case "subscriptions":
      console.log(JSON.stringify(subscriptions(readHar(paths[0])), null, 2));
      break;
    default:
      console.error(
        "usage: har-profile.mjs [--host <name>] profile|diff|subscriptions <har>...",
      );
      process.exitCode = 2;
  }
}

main(process.argv.slice(2));
