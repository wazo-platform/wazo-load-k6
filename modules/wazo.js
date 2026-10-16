// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import encoding from "k6/encoding";
import http from "k6/http";

// In the shape http.batch() takes, so many tokens can be created at once
export function tokenRequest(engine, username, password, expiration = 600) {
  const credentials = encoding.b64encode(`${username}:${password}`);
  return {
    method: "POST",
    url: `https://${engine}/api/auth/0.1/token`,
    body: JSON.stringify({ backend: "wazo_user", expiration }),
    params: {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
    },
  };
}

export function createToken(engine, username, password) {
  const { method, url, body, params } = tokenRequest(
    engine,
    username,
    password,
  );
  const response = http.request(method, url, body, params);
  if (response.status !== 200) {
    throw new Error(`token for ${username}: HTTP ${response.status}`);
  }
  return response.json("data");
}
