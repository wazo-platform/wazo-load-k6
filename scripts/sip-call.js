// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import sip from "k6/x/sip";
import { check, sleep } from "k6";

const engine = __ENV.WAZO_ENGINE;
const calleeExten = __ENV.CALLEE_EXTEN;
const callerUsername = __ENV.CALLER_USERNAME;
const callerPassword = __ENV.CALLER_PASSWORD;
if (!engine || !calleeExten || !callerUsername || !callerPassword) {
  throw new Error(
    "WAZO_ENGINE, CALLEE_EXTEN, CALLER_USERNAME and CALLER_PASSWORD are required",
  );
}

const talkSeconds = Number(__ENV.TALK_SECONDS || 60);
if (__ENV.CALL_RATE && __ENV.SIMULTANEOUS_CALLS) {
  throw new Error(
    "CALL_RATE and SIMULTANEOUS_CALLS set the same thing, since concurrency" +
      " is the rate times TALK_SECONDS: give one or the other",
  );
}
const callRate = __ENV.SIMULTANEOUS_CALLS
  ? Number(__ENV.SIMULTANEOUS_CALLS) / talkSeconds
  : Number(__ENV.CALL_RATE || 0.5);

const members = Number(__ENV.MEMBERS || 50);
const memberBase = Number(__ENV.MEMBER_BASE || 10000);
const runSeconds = Number(__ENV.RUN_SECONDS || 300);
const audioFile = __ENV.AUDIO_FILE || "/audio/tone-3s.wav";
// auto-detection picks the default-route address, wrong over a VPN
const localIP = __ENV.SIP_LOCAL_IP || "";

const listenPortBase = 5070;
const listenPortMax = 15069;
const registerExpires = 120;
const warmupSeconds = 10;
// PCMU at 20ms ptime, less a fifth for setup and teardown inside the window
const minPacketsPerSecond = 40;
const minReceivedToSentRatio = 0.9;
const maxLossRatio = 0.01;
// PCMU tops out near 4.4, and the generator's own network costs some of that
const minMos = 4.0;
// past this a 20ms jitter buffer starts discarding
const maxJitterMs = 30;
// a caller can vanish without ever sending BYE
const memberCallCapSeconds = Math.ceil(10 * talkSeconds);

// k6 takes a whole-number arrival rate, so fractional rates go per minute
const ratePerMinute = Math.round(callRate * 60);
if (ratePerMinute < 1) {
  throw new Error(`${callRate} calls/s rounds to no calls per minute`);
}

const concurrency = (ratePerMinute / 60) * talkSeconds;
// calls in progress are Poisson around the mean, so 3 deviations cover the peak
const peakConcurrency = Math.ceil(concurrency + 3 * Math.sqrt(concurrency));

const minMembers = Math.ceil(concurrency);
if (members < minMembers) {
  throw new Error(
    `MEMBERS=${members} cannot answer ${concurrency} concurrent calls: a` +
      " member already on a call is not rung again, so CALL_RATE=" +
      `${callRate} with TALK_SECONDS=${talkSeconds} needs at least` +
      ` ${minMembers} members, and ${peakConcurrency} to cover the peak`,
  );
}

const listenPortTop = listenPortBase + members - 1;
if (listenPortTop > listenPortMax) {
  throw new Error(
    `MEMBERS=${members} listens up to port ${listenPortTop}, past the` +
      ` ${listenPortMax} the security group opens: at most` +
      ` ${listenPortMax - listenPortBase + 1} members fit`,
  );
}

// k6 cannot interrupt a call in progress, so the run drains for as long as
// the longest one may last
const memberSeconds = warmupSeconds + runSeconds + memberCallCapSeconds;

export const options = {
  scenarios: {
    members: {
      executor: "per-vu-iterations",
      exec: "member",
      vus: members,
      iterations: 1,
      // room past the sleep for stop() to unregister
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
  },
};

export function setup() {
  console.log(
    `${ratePerMinute} calls/min at ${talkSeconds}s mean talk time:` +
      ` ${concurrency.toFixed(1)} concurrent calls expected,` +
      ` ${peakConcurrency} VUs allocated, ${members} members from ${memberBase}`,
  );
}

export function member() {
  const index = exec.scenario.iterationInTest;
  const account = String(memberBase + index);

  const uas = sip.registerAndListen({
    registrar: `sip:${engine}`,
    aor: `sip:${account}@${engine}`,
    username: account,
    password: account,
    listenAddr: `0.0.0.0:${listenPortBase + index}`,
    localIP: localIP,
    expires: registerExpires,
    duration: `${memberCallCapSeconds}s`,
    audio: { file: audioFile, codec: "PCMU" },
  });

  sleep(memberSeconds);
  uas.stop();
}

export function caller() {
  const seconds = drawTalkSeconds();
  const result = sip.call({
    target: `sip:${calleeExten}@${engine}`,
    aor: `sip:${callerUsername}@${engine}`,
    username: callerUsername,
    password: callerPassword,
    duration: `${seconds.toFixed(1)}s`,
    localIP: localIP,
    audio: { file: audioFile, codec: "PCMU" },
    rtcp: true,
  });

  check(result, {
    "call answered": (r) => r.success === true,
    "audio flowed both ways": (r) =>
      r.received >= minReceivedToSentRatio * r.sent,
    "media ran the whole call": (r) => r.sent >= minPacketsPerSecond * seconds,
    "packet loss stayed low": (r) =>
      r.lost / (r.received + r.lost) < maxLossRatio,
    "MOS stayed good": (r) => r.mos >= minMos,
    "jitter stayed low": (r) => r.jitter < maxJitterMs,
  });
  if (!result.success) {
    console.error(
      `${callerUsername} -> ${calleeExten} failed: ${result.error}`,
    );
  }
}

function drawTalkSeconds() {
  const sample = -talkSeconds * Math.log(1 - Math.random());
  // a sub-second call would be torn down inside its own setup
  return Math.max(1, sample);
}
