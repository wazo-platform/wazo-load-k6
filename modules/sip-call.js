// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import sip from "k6/x/sip";
import { check } from "k6";

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

export const members = Number(__ENV.MEMBERS || 50);
const memberBase = Number(__ENV.MEMBER_BASE || 10000);
const listenPortBase = Number(__ENV.LISTEN_PORT_BASE || 5070);
const audioFile = __ENV.AUDIO_FILE || "/audio/tone-3s.wav";
// auto-detection picks the default-route address, wrong over a VPN
const localIP = __ENV.SIP_LOCAL_IP || "";

const listenPortMin = 5070;
const listenPortMax = 15069;
const registerExpires = 120;
// PCMU at 20ms ptime, less a fifth for setup and teardown inside the window
const minPacketsPerSecond = 40;
const minReceivedToSentRatio = 0.9;
const maxLossRatio = 0.01;
// PCMU tops out near 4.4, and the generator's own network costs some of that
export const minMos = 4.0;
// past this a 20ms jitter buffer starts discarding
export const maxJitterMs = 30;
// a caller can vanish without ever sending BYE
export const memberCallCapSeconds = Math.ceil(10 * talkSeconds);
const callSetupSeconds = 5;

// k6 takes a whole-number arrival rate, so fractional rates go per minute
export const ratePerMinute = Math.round(callRate * 60);
if (ratePerMinute < 1) {
  throw new Error(`${callRate} calls/s rounds to no calls per minute`);
}

const concurrency = (ratePerMinute / 60) * talkSeconds;
// calls in progress are Poisson around the mean, so 3 deviations cover the peak
export const peakConcurrency = Math.ceil(
  concurrency + 3 * Math.sqrt(concurrency),
);

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
if (listenPortBase < listenPortMin || listenPortTop > listenPortMax) {
  throw new Error(
    `MEMBERS=${members} from LISTEN_PORT_BASE=${listenPortBase} listens on` +
      ` ${listenPortBase}-${listenPortTop}, outside the` +
      ` ${listenPortMin}-${listenPortMax} the security group opens`,
  );
}

export function describeLoad() {
  return (
    `${ratePerMinute} calls/min at ${talkSeconds}s mean talk time:` +
    ` ${concurrency.toFixed(1)} concurrent calls expected,` +
    ` ${peakConcurrency} VUs allocated, ${members} members from ${memberBase}` +
    ` on ports ${listenPortBase}-${listenPortTop}`
  );
}

export function registerMember(index) {
  const account = String(memberBase + index);
  return sip.registerAndListen({
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
}

export function placeCall() {
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
  // the member hangs up at its cap, counted from before the call is answered
  const longest = memberCallCapSeconds - callSetupSeconds;
  // a sub-second call would be torn down inside its own setup
  return Math.max(1, Math.min(longest, sample));
}
