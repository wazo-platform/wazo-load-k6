// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { checkStackInvariants } from "../../modules/monitor-checks/stack-invariants.js";
import { createToken, tokenRequest } from "../../modules/wazo.js";

const engine = __ENV.WAZO_ENGINE;
const adminUsername = __ENV.WAZO_ADMIN_USERNAME;
const adminPassword = __ENV.WAZO_ADMIN_PASSWORD;
const tenant = __ENV.WAZO_TENANT;
if (!engine || !adminUsername || !adminPassword || !tenant) {
  throw new Error(
    "WAZO_ENGINE, WAZO_ADMIN_USERNAME, WAZO_ADMIN_PASSWORD and WAZO_TENANT are required",
  );
}

// wazo-load-tools gives every user this password, with its email as username
const usersPassword = __ENV.WAZO_USERS_PASSWORD || "secret";
// Every fixture entry carries "User" in its first name, as the load-tools
// users do, so the default term matches all of them in every backend
const term = __ENV.LOOKUP_TERM || "user";
const lookupRate = Number(__ENV.LOOKUP_RATE || 10);
const lookupSeconds = Number(__ENV.LOOKUP_SECONDS || 60);

const dird = `https://${engine}/api/dird/0.1`;

const FIXTURE_NAME = "dird-lookup-limit";
const PHONEBOOK_CONTACTS = 5000;
const PERSONAL_CONTACTS_PER_USER = 5;
// The personal source answers with the contacts of the caller only, so the
// lookups are made as these users, not as the admin
const LOOKUP_USERS = 100;
const SEED_BATCH_USERS = 50;
const WARM_UP_REQUESTS = 3;

const lookupResults = new Trend("lookup_results");
const lookupBodySize = new Trend("lookup_body_size");

export const options = {
  insecureSkipTLSVerify: true,
  // Seeding creates 25000 personal contacts, one user at a time
  setupTimeout: "30m",
  batch: SEED_BATCH_USERS * PERSONAL_CONTACTS_PER_USER,
  batchPerHost: SEED_BATCH_USERS,
  scenarios: {
    "dird-lookup-limit": {
      executor: "constant-arrival-rate",
      rate: lookupRate,
      timeUnit: "1s",
      duration: `${lookupSeconds}s`,
      // A lookup answering thousands of results can take seconds: let the
      // last ones finish rather than cut them
      gracefulStop: "30s",
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: "dirdLookup",
    },
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  // No latency threshold: this script compares a stack with and without the
  // lookup limit, and a bound sized for one would fail the other by design
  thresholds: {
    // An empty metric passes every other threshold
    "http_reqs{scenario:dird-lookup-limit,name:lookup}": ["count>0"],
    checks: ["rate==1.0"],
    monitor_checks: ["rate==1.0"],
  },
};

function expectStatus(response, statuses, what) {
  if (!statuses.includes(response.status)) {
    throw new Error(`${what}: HTTP ${response.status} ${response.body}`);
  }
  return response;
}

function adminHeaders(token, contentType) {
  const headers = { "X-Auth-Token": token, "Wazo-Tenant": tenant };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return { headers };
}

function listLoadUsers(token) {
  const response = http.get(
    `https://${engine}/api/confd/1.1/users?view=summary`,
    adminHeaders(token),
  );
  return expectStatus(response, [200], "users")
    .json("items")
    .filter(
      (user) =>
        user.firstname === "User" && /^\d+$/.test(user.lastname) && user.email,
    );
}

function findByName(url, token, what) {
  const query = `search=${encodeURIComponent(FIXTURE_NAME)}`;
  const response = http.get(`${url}?${query}`, adminHeaders(token));
  return expectStatus(response, [200], what)
    .json("items")
    .find((item) => item.name === FIXTURE_NAME);
}

function ensurePhonebook(token) {
  const found = findByName(`${dird}/phonebooks`, token, "phonebooks");
  if (found) {
    return found.uuid;
  }
  const response = http.post(
    `${dird}/phonebooks`,
    JSON.stringify({ name: FIXTURE_NAME }),
    adminHeaders(token, "application/json"),
  );
  return expectStatus(response, [201], "phonebook").json("uuid");
}

function fillPhonebook(token, phonebookUuid) {
  const contacts = `${dird}/phonebooks/${phonebookUuid}/contacts`;
  const total = expectStatus(
    http.get(`${contacts}?limit=1`, adminHeaders(token)),
    [200],
    "phonebook contacts",
  ).json("total");
  if (total === PHONEBOOK_CONTACTS) {
    return;
  }
  // The import fails whole on a duplicate, so it cannot top up a phonebook
  if (total !== 0) {
    throw new Error(
      `phonebook ${FIXTURE_NAME} holds ${total} contacts, expected 0 or ${PHONEBOOK_CONTACTS}`,
    );
  }
  const rows = ["firstname,lastname,number,email"];
  for (let i = 0; i < PHONEBOOK_CONTACTS; i++) {
    rows.push(
      `PhonebookUser,${i},${2000000000 + i},phonebook.user${i}@example.com`,
    );
  }
  expectStatus(
    http.post(
      `${contacts}/import`,
      rows.join("\n"),
      adminHeaders(token, "text/csv; charset=utf-8"),
    ),
    [201],
    "phonebook import",
  );
}

function ensurePhonebookSource(token, phonebookUuid) {
  const sources = `${dird}/backends/phonebook/sources`;
  const found = findByName(sources, token, "phonebook sources");
  if (found) {
    return found.uuid;
  }
  const body = {
    name: FIXTURE_NAME,
    phonebook_uuid: phonebookUuid,
    searched_columns: ["firstname", "lastname", "number", "email"],
    first_matched_columns: ["number"],
    // The fields of the default display, so the results are as large as a
    // real phonebook's
    format_columns: {
      name: "{firstname} {lastname}",
      phone: "{number}",
      reverse: "{firstname} {lastname}",
    },
  };
  const response = http.post(
    sources,
    JSON.stringify(body),
    adminHeaders(token, "application/json"),
  );
  return expectStatus(response, [200], "phonebook source").json("uuid");
}

function addToDefaultLookup(token, sourceUuid) {
  const profiles = `${dird}/profiles`;
  const found = expectStatus(
    http.get(profiles, adminHeaders(token)),
    [200],
    "profiles",
  )
    .json("items")
    .find((profile) => profile.name === "default");
  if (!found) {
    throw new Error(`no default profile in tenant ${tenant}`);
  }
  const profile = expectStatus(
    http.get(`${profiles}/${found.uuid}`, adminHeaders(token)),
    [200],
    "default profile",
  ).json();

  // The update replaces the whole profile, and refuses a null "options"
  const services = {};
  for (const [name, service] of Object.entries(profile.services)) {
    services[name] = {
      sources: service.sources.map((source) => ({ uuid: source.uuid })),
    };
    if (service.options) {
      services[name].options = service.options;
    }
  }
  if (services.lookup.sources.some((source) => source.uuid === sourceUuid)) {
    return;
  }
  services.lookup.sources.push({ uuid: sourceUuid });

  const body = {
    name: profile.name,
    display: { uuid: profile.display.uuid },
    services,
  };
  expectStatus(
    http.put(
      `${profiles}/${found.uuid}`,
      JSON.stringify(body),
      adminHeaders(token, "application/json"),
    ),
    [204],
    "default profile update",
  );
}

function createTokens(users, expiration) {
  return http
    .batch(
      users.map((user) =>
        tokenRequest(engine, user.email, usersPassword, expiration),
      ),
    )
    .map((response, i) =>
      expectStatus(response, [200], `token for ${users[i].email}`).json(
        "data.token",
      ),
    );
}

function personalContact(user, index) {
  return {
    firstname: "PersonalUser",
    lastname: `${user.lastname}-${index}`,
    number: `${3000000000 + Number(user.lastname) * 10 + index}`,
  };
}

// One contact a request, not an import: an import loads every contact of the
// stack to check its ids, which makes seeding 25000 of them quadratic
function seedPersonalContacts(users) {
  for (let start = 0; start < users.length; start += SEED_BATCH_USERS) {
    const chunk = users.slice(start, start + SEED_BATCH_USERS);
    const tokens = createTokens(chunk);
    const requests = [];
    chunk.forEach((user, i) => {
      for (let k = 0; k < PERSONAL_CONTACTS_PER_USER; k++) {
        requests.push({
          method: "POST",
          url: `${dird}/personal`,
          body: JSON.stringify(personalContact(user, k)),
          params: {
            headers: {
              "Content-Type": "application/json",
              "X-Auth-Token": tokens[i],
            },
          },
        });
      }
    });
    // 409: a previous run created it already
    http
      .batch(requests)
      .forEach((response) =>
        expectStatus(response, [201, 409], "personal contact"),
      );
  }
}

function lookup(token, name) {
  const query = `term=${encodeURIComponent(term)}`;
  return http.get(`${dird}/directories/lookup/default?${query}`, {
    headers: { "X-Auth-Token": token },
    tags: { name },
  });
}

export function setup() {
  const runStart = Date.now();
  const adminToken = createToken(engine, adminUsername, adminPassword).token;
  const users = listLoadUsers(adminToken);
  if (users.length === 0) {
    throw new Error(`no wazo-load-tools user in tenant ${tenant}`);
  }

  const phonebookUuid = ensurePhonebook(adminToken);
  fillPhonebook(adminToken, phonebookUuid);
  addToDefaultLookup(
    adminToken,
    ensurePhonebookSource(adminToken, phonebookUuid),
  );
  seedPersonalContacts(users);

  // Created last and outliving the run, however long the seeding took
  const tokens = createTokens(
    users.slice(0, LOOKUP_USERS),
    lookupSeconds + 600,
  );

  // dird loads its sources on the first requests: done here, it is over
  // before the load starts, which an arrival rate does not wait for
  for (let i = 0; i < WARM_UP_REQUESTS; i++) {
    lookup(tokens[i % tokens.length], "warm-up");
  }

  console.log(
    `${users.length} users, ${PHONEBOOK_CONTACTS} phonebook contacts, ` +
      `${users.length * PERSONAL_CONTACTS_PER_USER} personal contacts; ` +
      `looking up "${term}" ${lookupRate}/s for ${lookupSeconds}s ` +
      `as ${tokens.length} users`,
  );
  return { runStart, tokens };
}

export function teardown({ runStart }) {
  checkStackInvariants(runStart);
}

// Round-robin rather than random: every run sends the same requests, so
// runs compare alike
export function dirdLookup({ tokens }) {
  const token = tokens[exec.scenario.iterationInTest % tokens.length];
  const response = lookup(token, "lookup");
  // The count alone, without building thousands of objects in the generator
  const results = response.status === 200 ? response.json("results.#") : 0;
  lookupResults.add(results);
  lookupBodySize.add(response.body ? response.body.length : 0);
  check(response, {
    "lookup found results": (r) => r.status === 200 && results > 0,
  });
}
