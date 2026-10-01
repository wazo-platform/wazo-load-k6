// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import { sleep } from "k6";
import {
  checkMonitor,
  stackMatcher,
} from "../../modules/monitor-checks/check.js";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
import {
  describeLoad,
  maxJitterMs,
  memberCallCapSeconds,
  members,
  minMos,
  peakConcurrency,
  placeCall,
  ratePerMinute,
  registerMember,
} from "../../modules/sip-call.js";

const runSeconds = Number(__ENV.RUN_SECONDS || 300);

const warmupSeconds = 10;
// what an app waiting on the stack tolerates, calls in progress or not
const maxServiceLatencySeconds = 1;

const callerWindowSeconds = warmupSeconds + runSeconds;
// the calls offered in the window run to their end, so the drain is bounded
// by the longest one that may still be up
const memberSeconds = callerWindowSeconds + memberCallCapSeconds;

export const options = {
  scenarios: {
    members: {
      executor: "per-vu-iterations",
      exec: "member",
      vus: members,
      iterations: 1,
      // room past the drain for stop() to unregister
      maxDuration: `${memberSeconds + 10}s`,
    },
    caller: {
      executor: "constant-arrival-rate",
      exec: "caller",
      startTime: `${warmupSeconds}s`,
      rate: ratePerMinute,
      timeUnit: "1m",
      duration: `${runSeconds}s`,
      gracefulStop: `${memberCallCapSeconds}s`,
      preAllocatedVUs: peakConcurrency,
      maxVUs: peakConcurrency,
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    sip_register_success: [`count>=${members}`],
    // a proportion, not a count: one rejection should not fail a long run
    checks: ["rate>0.99"],
    // likewise a percentile rather than min or max, for the trends
    mos_score: [`p(5)>${minMos}`],
    rtp_jitter_ms: [`p(95)<${maxJitterMs}`],
    monitor_checks: ["rate==1.0"],
  },
};

export function setup() {
  console.log(describeLoad());
  return { runStart: Date.now() };
}

export function teardown({ runStart }) {
  checkStackInvariants(runStart);
  checkMonitor(
    "service latency",
    runStart,
    (window) =>
      `histogram_quantile(0.95, sum by (service, le) (increase(flask_http_request_duration_seconds_bucket{${stackMatcher()}}[${window}])))` +
      ` > ${maxServiceLatencySeconds}`,
  );
}

export function member() {
  const uas = registerMember(exec.scenario.iterationInTest);
  waitForCallsToDrain();
  uas.stop();
}

// no new call can arrive past the caller window, so an idle caller pool from
// then on means the last one has hung up
function waitForCallsToDrain() {
  while (exec.instance.currentTestRunDuration < memberSeconds * 1000) {
    if (
      exec.instance.currentTestRunDuration > callerWindowSeconds * 1000 &&
      exec.instance.vusActive <= members
    ) {
      return;
    }
    sleep(1);
  }
}

export function caller() {
  placeCall();
}
