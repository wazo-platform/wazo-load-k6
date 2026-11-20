// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import encoding from "k6/encoding";
import http from "k6/http";

// A request for http.batch
export function tokenRequest(engine, username, password, expiration = 600) {
  const credentials = encoding.b64encode(`${username}:${password}`);
  return [
    "POST",
    `https://${engine}/api/auth/0.1/token`,
    JSON.stringify({ backend: "wazo_user", expiration }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
    },
  ];
}

export function createToken(engine, username, password, expiration = 600) {
  const [, url, body, params] = tokenRequest(
    engine,
    username,
    password,
    expiration,
  );
  const response = http.post(url, body, params);
  if (response.status !== 200) {
    throw new Error(`token for ${username}: HTTP ${response.status}`);
  }
  return response.json("data");
}
