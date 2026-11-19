// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Seeded lookup traffic: a Zipf-weighted term pool and per-user bursts

import { randomSeed } from "k6";

const STAR_CODES = ["*5024", "*5025", "*8000"];

// Reseeding per iteration keeps a burst independent of the VU running it
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

// Hits: extensions, mobiles, and every second mobile without its leading 0.
// Misses: star codes and unknown 9-digit numbers, half also with a leading 0.
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

// Each user resends one list of terms, a few replaced at each burst
export function createBurstGenerator(pool, options) {
  const { exponent, churn, minSize, maxSize, seed } = options;
  const draw = createSampler(pool, exponent);

  function userList(userIndex) {
    seedStream(seed, USER, userIndex);
    const size = minSize + Math.floor(Math.random() * (maxSize - minSize + 1));
    return Array.from({ length: size }, draw);
  }

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

// The least popular hit, for a cold-cache lookup
export function coldTerm(pool) {
  const term = pool.findLast((entry) => entry.hit);
  if (!term) {
    throw new Error("no hit term in the pool");
  }
  return term;
}
