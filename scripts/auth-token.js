// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import encoding from 'k6/encoding';
import http from 'k6/http';
import { check } from 'k6';

const engine = __ENV.WAZO_ENGINE;
const username = __ENV.WAZO_USERNAME;
const password = __ENV.WAZO_PASSWORD;
if (!engine || !username || !password) {
  throw new Error('WAZO_ENGINE, WAZO_USERNAME and WAZO_PASSWORD are required');
}

const credentials = encoding.b64encode(`${username}:${password}`);

export const options = {
  vus: Number(__ENV.VUS || 1),
  duration: __ENV.DURATION || '10s',
  insecureSkipTLSVerify: true,
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default function () {
  const body = JSON.stringify({ backend: 'wazo_user', expiration: 60 });
  const response = http.post(`https://${engine}/api/auth/0.1/token`, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
  });
  check(response, { 'token minted': (r) => r.status === 200 && r.json('data.token') });
}
