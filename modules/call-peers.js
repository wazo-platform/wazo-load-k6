// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// The other party of each call in a call-logd history, once per number, most
// recent first: the mobile app looks each of them up when a session opens
export function callPeers(cdr, userUuid) {
  const peers = new Map();
  for (const call of cdr.items) {
    const outgoing = call.source_user_uuid === userUuid;
    const number = outgoing
      ? call.destination_extension
      : call.source_extension;
    const uuid = outgoing ? call.destination_user_uuid : call.source_user_uuid;
    if (!peers.has(number)) peers.set(number, { number, uuid });
  }
  return [...peers.values()];
}
