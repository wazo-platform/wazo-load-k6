// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import encoding from "k6/encoding";
import http from "k6/http";

export function createToken(engine, username, password) {
  const credentials = encoding.b64encode(`${username}:${password}`);
  const body = JSON.stringify({ backend: "wazo_user", expiration: 600 });
  const response = http.post(`https://${engine}/api/auth/0.1/token`, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
  });
  if (response.status !== 200) {
    throw new Error(`token for ${username}: HTTP ${response.status}`);
  }
  return response.json("data");
}
