// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Directory lookup traffic: a pool of numeric terms with a Zipf popularity,
// and bursts of lookups, one burst for each user. Everything derives from a
// seed, so two runs send the same requests and compare alike.

import { randomSeed } from "k6";

const STAR_CODES = ["*5024", "*5025", "*8000"];

// Seeds Math.random for one stream: the pool, a user's list or a burst. A
// burst reseeds by its iteration, so its terms do not depend on which VU
// runs it
const POOL = 0;
const USER = 1;
const BURST = 2;
const CHURN = 3;
function seedStream(seed, stream, index = 0) {
  randomSeed(seed * 1e9 + stream * 1e8 + index);
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

// Hits are what the dataset holds: the extensions and, when users have them,
// the mobile numbers and the mobile numbers without their leading 0 for every
// second user. Misses are star codes and 9-digit numbers nobody holds, each
// second one also with a leading 0: the lookups of callers outside the
// directory, which a stack whose users have no mobile number is made of. The
// order is shuffled, so the popular terms are not tied to the user order.
export function buildTermPool(extens, mobiles, poolRatio, seed) {
  const hits = new Set(extens);
  mobiles.forEach((mobile, index) => {
    hits.add(mobile);
    if (index % 2 === 0 && mobile.startsWith("0")) {
      hits.add(mobile.slice(1));
    }
  });
  const known = new Set(hits);
  const pool = [...hits].map((term) => ({ term, hit: true }));

  for (const term of STAR_CODES) {
    pool.push({ term, hit: false });
    known.add(term);
  }
  const size = Math.round(extens.length * poolRatio);
  seedStream(seed, POOL);
  let numbers = 0;
  while (pool.length < size) {
    const term = String(600000000 + Math.floor(Math.random() * 399999999));
    if (known.has(term) || known.has(`0${term}`)) {
      continue;
    }
    known.add(term);
    known.add(`0${term}`);
    pool.push({ term, hit: false });
    if (numbers++ % 2 === 0 && pool.length < size) {
      pool.push({ term: `0${term}`, hit: false });
    }
  }
  shuffle(pool);
  return pool;
}

// Pool rank r is drawn with a weight of 1 / r^exponent
export function createSampler(pool, exponent) {
  const cumulative = new Float64Array(pool.length);
  let total = 0;
  for (let rank = 1; rank <= pool.length; rank++) {
    total += 1 / Math.pow(rank, exponent);
    cumulative[rank - 1] = total;
  }
  return function draw() {
    const target = Math.random() * total;
    let low = 0;
    let high = pool.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return pool[low];
  };
}

// A user keeps one list of terms and sends it again at each burst, a term
// changing now and then: a list on a screen that is opened over and over
export function createBurstGenerator(pool, options) {
  const { exponent, churn, minSize, maxSize, seed } = options;
  const draw = createSampler(pool, exponent);

  function userList(userIndex) {
    seedStream(seed, USER, userIndex);
    const size = minSize + Math.floor(Math.random() * (maxSize - minSize + 1));
    return Array.from({ length: size }, draw);
  }

  // The burst of one iteration: which user sends it, and its terms
  return function burst(iteration, userCount) {
    seedStream(seed, BURST, iteration);
    const userIndex = Math.floor(Math.random() * userCount);
    const list = userList(userIndex);
    seedStream(seed, CHURN, iteration);
    const entries = list.map((entry) =>
      Math.random() < churn ? draw() : entry,
    );
    return { userIndex, entries };
  };
}

// The least popular hit: nobody has asked for it when a run starts
export function coldTerm(pool) {
  const term = pool.findLast((entry) => entry.hit);
  if (!term) {
    throw new Error("no hit term in the pool");
  }
  return term;
}
