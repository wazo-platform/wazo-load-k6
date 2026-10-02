// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import { sleep } from "k6";
import {
  describeLoad,
  members,
  peakConcurrency,
  placeCall,
  ratePerMinute,
  registerMember,
} from "../../modules/sip-call.js";

// k6 has no endless executor: a year stands for until stopped
const runSeconds = 365 * 24 * 3600;

export const options = {
  scenarios: {
    members: {
      executor: "per-vu-iterations",
      exec: "member",
      vus: members,
      iterations: 1,
      maxDuration: `${runSeconds}s`,
      // outlives the callers' BYE, which a member must still answer
      gracefulStop: "10s",
    },
    caller: {
      executor: "constant-arrival-rate",
      exec: "caller",
      // the members register first
      startTime: "10s",
      rate: ratePerMinute,
      timeUnit: "1m",
      duration: `${runSeconds}s`,
      // interrupting a call hangs it up, leaving no call up on the stack
      gracefulStop: "0s",
      preAllocatedVUs: peakConcurrency,
      maxVUs: peakConcurrency,
    },
  },
};

export function setup() {
  console.log(describeLoad());
}

export function member() {
  const uas = registerMember(exec.scenario.iterationInTest);
  sleep(runSeconds);
  uas.stop();
}

export function caller() {
  placeCall();
}
