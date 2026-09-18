// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import sip from 'k6/x/sip';
import { check, sleep } from 'k6';

const engine = __ENV.WAZO_ENGINE;
const callerUsername = __ENV.CALLER_USERNAME;
const callerPassword = __ENV.CALLER_PASSWORD;
const calleeUsername = __ENV.CALLEE_USERNAME;
const calleePassword = __ENV.CALLEE_PASSWORD;
const calleeExten = __ENV.CALLEE_EXTEN;
if (
  !engine ||
  !callerUsername ||
  !callerPassword ||
  !calleeUsername ||
  !calleePassword ||
  !calleeExten
) {
  throw new Error(
    'WAZO_ENGINE, CALLER_USERNAME, CALLER_PASSWORD, CALLEE_USERNAME,' +
      ' CALLEE_PASSWORD and CALLEE_EXTEN are required'
  );
}

const callSeconds = Number(__ENV.CALL_SECONDS || 10);
const listenPort = __ENV.LISTEN_PORT || '5070';
const audioFile = __ENV.AUDIO_FILE || '/audio/tone-3s.wav';
// auto-detection advertises the default-route address in Via, Contact and SDP,
// which is the wrong one when the engine is reached over a VPN
const localIP = __ENV.SIP_LOCAL_IP || '';

const callerStartSeconds = 2;
const listenSeconds = callerStartSeconds + callSeconds + 5;

export const options = {
  scenarios: {
    callee: {
      executor: 'shared-iterations',
      exec: 'callee',
      vus: 1,
      iterations: 1,
      maxDuration: `${listenSeconds + 15}s`,
    },
    caller: {
      executor: 'shared-iterations',
      exec: 'caller',
      vus: 1,
      iterations: 1,
      startTime: `${callerStartSeconds}s`,
      maxDuration: `${callSeconds + 30}s`,
    },
  },
  thresholds: {
    sip_register_success: ['count==2'],
    sip_call_success: ['count==1'],
    sip_call_failure: ['count==0'],
    rtp_packets_received: ['count>0'],
  },
};

export function callee() {
  const uas = sip.registerAndListen({
    registrar: `sip:${engine}`,
    aor: `sip:${calleeUsername}@${engine}`,
    username: calleeUsername,
    password: calleePassword,
    listenAddr: `0.0.0.0:${listenPort}`,
    localIP: localIP,
    expires: 120,
    audio: { file: audioFile, codec: 'PCMU' },
  });
  check(uas, { 'callee registered': (u) => u !== null });

  sleep(listenSeconds);
  uas.stop();
}

export function caller() {
  const registration = sip.register({
    registrar: `sip:${engine}`,
    aor: `sip:${callerUsername}@${engine}`,
    username: callerUsername,
    password: callerPassword,
    expires: 120,
    localIP: localIP,
  });
  check(registration, { 'caller registered': (r) => r !== null });

  const result = sip.call({
    target: `sip:${calleeExten}@${engine}`,
    aor: `sip:${callerUsername}@${engine}`,
    username: callerUsername,
    password: callerPassword,
    duration: `${callSeconds}s`,
    localIP: localIP,
    audio: { file: audioFile, codec: 'PCMU' },
    rtcp: true,
  });
  check(result, {
    'call answered': (r) => r.success === true,
    'RTP received from the callee': (r) => r.received > 0,
  });
  if (result.success) {
    console.log(
      `${callerUsername} -> ${calleeExten}: sent=${result.sent}` +
        ` received=${result.received} lost=${result.lost}` +
        ` jitter=${result.jitter.toFixed(2)}ms MOS=${result.mos.toFixed(2)}`
    );
  } else {
    console.error(`${callerUsername} -> ${calleeExten} failed: ${result.error}`);
  }

  check(registration.unregister(), { 'caller unregistered': (e) => e == null });
}
