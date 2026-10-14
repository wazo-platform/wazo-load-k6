// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import http from "k6/http";
import { memberBase, members } from "./sip-call.js";
import { createToken } from "./wazo.js";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) {
  throw new Error("WAZO_ADMIN_USERNAME and WAZO_ADMIN_PASSWORD are required");
}

const agentd = `https://${engine}/api/agentd/1.0`;

// A member's agent is numbered after its line's extension
export function loginMemberAgents() {
  const token = createToken(engine, adminUsername, adminPassword).token;
  const { tenant, context } = memberContext(token);
  for (const number of memberNumbers()) {
    const response = http.post(
      `${agentd}/agents/by-number/${number}/login`,
      JSON.stringify({ extension: number, context: context }),
      { headers: headers(token, tenant) },
    );
    // an interrupted run leaves its agents logged in
    if (response.status !== 204 && response.status !== 409) {
      throw new Error(`login of agent ${number}: HTTP ${response.status}`);
    }
  }
}

export function logoffMemberAgents() {
  const token = createToken(engine, adminUsername, adminPassword).token;
  const { tenant } = memberContext(token);
  for (const number of memberNumbers()) {
    const response = http.post(
      `${agentd}/agents/by-number/${number}/logoff`,
      null,
      { headers: headers(token, tenant) },
    );
    if (response.status !== 204 && response.status !== 409) {
      throw new Error(`logoff of agent ${number}: HTTP ${response.status}`);
    }
  }
}

function memberContext(token) {
  const response = http.get(
    `https://${engine}/api/confd/1.1/extensions?exten=${memberBase}&recurse=true`,
    { headers: { "X-Auth-Token": token } },
  );
  if (response.status !== 200) {
    throw new Error(`extension ${memberBase}: HTTP ${response.status}`);
  }
  const extensions = response.json("items");
  if (extensions.length !== 1) {
    throw new Error(
      `extension ${memberBase}: ${extensions.length} found, expected 1`,
    );
  }
  return {
    tenant: extensions[0].tenant_uuid,
    context: extensions[0].context,
  };
}

function memberNumbers() {
  return Array.from({ length: members }, (_, index) =>
    String(memberBase + index),
  );
}

function headers(token, tenant) {
  return {
    "Content-Type": "application/json",
    "X-Auth-Token": token,
    "Wazo-Tenant": tenant,
  };
}
