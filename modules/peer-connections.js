// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Runs before the page's own scripts, so whatever WebRTC library the page
// uses gets the wrapped constructor
const tracker = `{
  const NativePeerConnection = globalThis.RTCPeerConnection;
  globalThis.loadTestPeerConnections = [];
  globalThis.RTCPeerConnection = class extends NativePeerConnection {
    constructor(...args) {
      super(...args);
      globalThis.loadTestPeerConnections.push(this);
    }
  };
}`;

export async function trackPeerConnections(context) {
  await context.addInitScript(tracker);
}

// A call has ended once every connection the page opened is closed
export async function waitForPeerConnectionsClosed(page, timeoutMs) {
  await page.waitForFunction(
    () =>
      globalThis.loadTestPeerConnections.every(
        (connection) => connection.connectionState === "closed",
      ),
    { polling: 500, timeout: timeoutMs },
  );
}

// Audio RTP packets of the page's open connections
export async function rtpPackets(page) {
  // page.evaluate truncates a returned object literal: pass it as JSON
  const packets = await page.evaluate(async () => {
    let sent = 0;
    let received = 0;
    for (const connection of globalThis.loadTestPeerConnections) {
      if (connection.connectionState === "closed") {
        continue;
      }
      const reports = await connection.getStats();
      reports.forEach((report) => {
        if (report.kind !== "audio") {
          return;
        }
        if (report.type === "outbound-rtp") {
          sent += report.packetsSent;
        }
        if (report.type === "inbound-rtp") {
          received += report.packetsReceived;
        }
      });
    }
    return JSON.stringify({ sent, received });
  });
  return JSON.parse(packets);
}
