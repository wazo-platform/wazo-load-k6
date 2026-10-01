// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import http from "k6/http";
import { sleep } from "k6";
import { Rate } from "k6/metrics";

const prometheus = __ENV.MONITOR_CHECKS_PROMETHEUS_URL;

// Two scrape intervals: an exporter missing both is down
const SCRAPE_TIMEOUT_SECONDS = 30;
const SCRAPE_POLL_SECONDS = 1;

const monitorChecks = new Rate("monitor_checks");

// The monitor labels the stack's series with the testid it is tagged with,
// the one k6 tags this run's metrics with
export function stackMatcher() {
  const testId = exec.test.options.tags?.testid;
  if (!testId) {
    throw new Error(
      "a testid tag is required with MONITOR_CHECKS_PROMETHEUS_URL",
    );
  }
  return `testid="${testId}"`;
}

// The monitor scrapes the load-testing job on stacks that do not serve it
function exportersMatcher() {
  return `${stackMatcher()},job!="load-testing"`;
}

function query(name, promql) {
  const response = http.get(
    `${prometheus}/api/v1/query?query=${encodeURIComponent(promql)}`,
    { tags: { name: "monitor-check" } },
  );
  if (response.status !== 200) {
    throw new Error(`monitor check ${name}: HTTP ${response.status}`);
  }
  return response.json("data.result");
}

function record(name, failures) {
  for (const failure of failures) {
    console.error(
      `monitor check ${name} failed: ${JSON.stringify(failure.metric)} = ${failure.value[1]}`,
    );
  }
  monitorChecks.add(failures.length === 0, { check: name });
}

// Prometheus has no scrape on demand, so wait for every exporter of the
// stack to be scraped once after the run, as told by its `up` sample time
function waitForScrapes() {
  const runEnd = Date.now() / 1000;
  const deadline = runEnd + SCRAPE_TIMEOUT_SECONDS;
  const promql = `min(timestamp(up{${exportersMatcher()}}))`;
  while (Date.now() / 1000 < deadline) {
    const [oldest] = query("scraped after the run", promql);
    if (oldest && Number(oldest.value[1]) > runEnd) {
      return true;
    }
    sleep(SCRAPE_POLL_SECONDS);
  }
  console.error(
    `monitor check scraped after the run failed: an exporter of ${stackMatcher()}` +
      ` was not scraped within ${SCRAPE_TIMEOUT_SECONDS}s`,
  );
  return false;
}

let ready = false;

function prepareOnce() {
  if (ready) {
    return;
  }
  ready = true;
  if (!prometheus) {
    console.warn(
      "MONITOR_CHECKS_PROMETHEUS_URL is not set: monitor checks are skipped",
    );
    return;
  }
  monitorChecks.add(waitForScrapes(), { check: "scraped after the run" });
  // A failed scrape still stamps `up`, leaving that exporter's series stale
  record(
    "exporter down",
    query("exporter down", `up{${exportersMatcher()}} == 0`),
  );
}

// buildQuery gets the run window and returns the series breaking the check
export function checkMonitor(name, runStart, buildQuery) {
  prepareOnce();
  if (!prometheus) {
    return;
  }
  const window = `${Math.ceil((Date.now() - runStart) / 1000)}s`;
  record(name, query(name, buildQuery(window)));
}
