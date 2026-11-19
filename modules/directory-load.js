// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Directory lookup traffic: a pool of numeric terms with a Zipf popularity,
// and bursts of lookups, one burst for each user. Everything derives from a
// seed, so two runs send the same requests and compare alike.

const STAR_CODES = ["*5024", "*5025", "*8000"];

// A 32-bit generator: small, and the same in k6 and in node
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each (seed, ...parts) gives its own stream: the terms of an iteration do not
// depend on which VU runs it
export function deriveSeed(seed, ...parts) {
  let hash = seed >>> 0;
  for (const part of parts) {
    hash = Math.imul(hash ^ (part >>> 0), 0x9e3779b1) >>> 0;
    hash ^= hash >>> 15;
  }
  return hash >>> 0;
}

function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
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
  const rng = createRng(deriveSeed(seed, 1));
  let numbers = 0;
  while (pool.length < size) {
    const term = String(600000000 + Math.floor(rng() * 399999999));
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
  shuffle(pool, createRng(deriveSeed(seed, 2)));
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
  return function draw(rng) {
    const target = rng() * total;
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

function burstSize(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// A user keeps one list of terms and sends it again at each burst, a term
// changing now and then: a list on a screen that is opened over and over
export function createBurstGenerator(pool, options) {
  const { exponent, churn, minSize, maxSize, seed } = options;
  const draw = createSampler(pool, exponent);

  function userList(userIndex) {
    const rng = createRng(deriveSeed(seed, 3, userIndex));
    const list = [];
    const size = burstSize(rng, minSize, maxSize);
    for (let i = 0; i < size; i++) {
      list.push(draw(rng));
    }
    return list;
  }

  return function burst(iteration, userIndex) {
    const rng = createRng(deriveSeed(seed, 4, iteration));
    return userList(userIndex).map((entry) =>
      rng() < churn ? draw(rng) : entry,
    );
  };
}

export function meanBurstSize(minSize, maxSize) {
  return (minSize + maxSize) / 2;
}

// The least popular hit: nobody has asked for it when a run starts
export function coldTerm(pool) {
  for (let i = pool.length - 1; i >= 0; i--) {
    if (pool[i].hit) {
      return pool[i];
    }
  }
  throw new Error("no hit term in the pool");
}
