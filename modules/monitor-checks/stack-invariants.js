// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import { checkMonitor, stackMatcher } from "./check.js";

const MAX_SERVER_ERROR_RATE = 0.001;

export function checkStackInvariants(runStart) {
  checkMonitor(
    "service restarted",
    runStart,
    (window) =>
      `changes(process_start_time_seconds{${stackMatcher()},service=~"wazo-.+"}[${window}]) > 0`,
  );
  checkMonitor(
    "process restarted",
    runStart,
    (window) =>
      `changes(namedprocess_namegroup_oldest_start_time_seconds{${stackMatcher()}}[${window}]) > 0`,
  );
  checkMonitor(
    "OOM kill",
    runStart,
    (window) =>
      `increase(node_vmstat_oom_kill{${stackMatcher()}}[${window}]) > 0`,
  );
  checkMonitor(
    "server errors",
    runStart,
    (window) =>
      `sum by (service) (increase(flask_http_request_duration_seconds_count{${stackMatcher()},status=~"5.."}[${window}]))` +
      ` / sum by (service) (increase(flask_http_request_duration_seconds_count{${stackMatcher()}}[${window}]))` +
      ` > ${MAX_SERVER_ERROR_RATE}`,
  );
  // Compared with the start of the run, so a consumer joining is no failure
  checkMonitor(
    "RabbitMQ consumer lost",
    runStart,
    (window) =>
      `min_over_time(rabbitmq_queue_consumers{${stackMatcher()}}[${window}])` +
      ` < rabbitmq_queue_consumers{${stackMatcher()}} offset ${window}`,
  );
}
