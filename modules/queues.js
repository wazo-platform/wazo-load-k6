// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import http from "k6/http";

const engine = __ENV.WAZO_ENGINE;
const confd = `https://${engine}/api/confd/1.1`;

const PREFIX = "load-queue-";

function params(token, tenant) {
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
      "Wazo-Tenant": tenant,
    },
  };
}

function request(method, url, body, token, tenant, expected) {
  const response = http.request(
    method,
    url,
    body === null ? null : JSON.stringify(body),
    params(token, tenant),
  );
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${url}: HTTP ${response.status} ${response.body}`,
    );
  }
  return response;
}

function incallContext(token, tenant) {
  const contexts = request(
    "GET",
    `${confd}/contexts?type=incall`,
    null,
    token,
    tenant,
    [200],
  ).json("items");
  if (contexts.length !== 1) {
    throw new Error(`${contexts.length} incall contexts, expected 1`);
  }
  return contexts[0].name;
}

function agentIds(token, tenant) {
  const agents = request(
    "GET",
    `${confd}/agents?limit=100000`,
    null,
    token,
    tenant,
    [200],
  ).json("items");
  return new Map(agents.map((agent) => [agent.number, agent.id]));
}

// Queues ringing the agents numbered in `members` (one array of agent
// numbers per queue), each reached by the trunk through an incall on
// `extenBase` and up
export function createQueues(token, tenant, { strategy, extenBase, members }) {
  const context = incallContext(token, tenant);
  const agents = agentIds(token, tenant);
  return members.map((numbers, index) => {
    const exten = String(extenBase + index);
    const queue = request(
      "POST",
      `${confd}/queues`,
      {
        name: `${PREFIX}${strategy}-${index}`,
        label: `${PREFIX}${strategy}-${index}`,
        // ringing until an agent answers, as the callees queue does
        ring_on_hold: true,
        options: [
          ["strategy", strategy],
          ["ringinuse", "no"],
        ],
      },
      token,
      tenant,
      [201],
    ).json();
    for (const number of numbers) {
      const agentId = agents.get(number);
      if (agentId === undefined) {
        throw new Error(`agent ${number} not found`);
      }
      request(
        "PUT",
        `${confd}/queues/${queue.id}/members/agents/${agentId}`,
        { penalty: 0 },
        token,
        tenant,
        [204],
      );
    }
    const incall = request(
      "POST",
      `${confd}/incalls`,
      {
        description: `${PREFIX}${strategy}-${index}`,
        destination: { type: "queue", queue_id: queue.id },
      },
      token,
      tenant,
      [201],
    ).json();
    const extension = request(
      "POST",
      `${confd}/extensions`,
      { exten, context },
      token,
      tenant,
      [201],
    ).json();
    request(
      "PUT",
      `${confd}/incalls/${incall.id}/extensions/${extension.id}`,
      null,
      token,
      tenant,
      [204],
    );
    return exten;
  });
}

// Also removes what a stopped run left
export function deleteQueues(token, tenant) {
  const incalls = request(
    "GET",
    `${confd}/incalls?search=${PREFIX}&limit=100000`,
    null,
    token,
    tenant,
    [200],
  ).json("items");
  for (const incall of incalls) {
    for (const extension of incall.extensions) {
      request(
        "DELETE",
        `${confd}/incalls/${incall.id}/extensions/${extension.id}`,
        null,
        token,
        tenant,
        [204],
      );
      request(
        "DELETE",
        `${confd}/extensions/${extension.id}`,
        null,
        token,
        tenant,
        [204],
      );
    }
    request(
      "DELETE",
      `${confd}/incalls/${incall.id}`,
      null,
      token,
      tenant,
      [204],
    );
  }
  const queues = request(
    "GET",
    `${confd}/queues?search=${PREFIX}&limit=100000`,
    null,
    token,
    tenant,
    [200],
  ).json("items");
  for (const queue of queues) {
    request(
      "DELETE",
      `${confd}/queues/${queue.id}`,
      null,
      token,
      tenant,
      [204],
    );
  }
}
