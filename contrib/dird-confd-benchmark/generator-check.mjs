// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

// Self-check of modules/directory-load.js, run with node:
//   node contrib/dird-confd-benchmark/generator-check.mjs

import assert from "node:assert/strict";
import {
  buildTermPool,
  coldTerm,
  createBurstGenerator,
  createRng,
  createSampler,
  deriveSeed,
} from "../../modules/directory-load.js";

const USERS = 4500;
const POOL_RATIO = 2.75;
const OPTIONS = {
  exponent: 0.7,
  churn: 0.25,
  minSize: 7,
  maxSize: 12,
  seed: 1,
};

// The users of the load stack: an extension each, no mobile number
const extens = Array.from({ length: USERS }, (_, i) => String(10000 + i));
const mobiles = [];

const pool = buildTermPool(extens, mobiles, POOL_RATIO, OPTIONS.seed);

// The pool has the asked size and every extension; the rest are misses, some
// of them with a leading 0 next to the same number without it
assert.equal(pool.length, Math.round(USERS * POOL_RATIO));
const terms = new Set(pool.map((entry) => entry.term));
assert.equal(terms.size, pool.length, "terms are unique");
for (const exten of extens) {
  assert.ok(terms.has(exten), `extension ${exten} is a term`);
}
assert.equal(pool.filter((entry) => entry.hit).length, USERS);
assert.ok(pool.some((entry) => entry.term.startsWith("*") && !entry.hit));
const numbers = pool.filter((entry) => /^\d{9,10}$/.test(entry.term));
assert.equal(numbers.length, pool.length - USERS - 3);
assert.ok(numbers.every((entry) => !entry.hit));
assert.ok(
  numbers.filter(
    (entry) => entry.term.startsWith("0") && terms.has(entry.term.slice(1)),
  ).length >
    USERS / 2,
  "leading-0 twins",
);

// Users that have a mobile number add hits, with the variant of every second
const mobilePool = buildTermPool(
  extens,
  extens.map((exten) => `0${600000000 + Number(exten)}`),
  POOL_RATIO,
  OPTIONS.seed,
);
assert.equal(mobilePool.length, Math.round(USERS * POOL_RATIO));
assert.ok(mobilePool.filter((entry) => entry.hit).length > USERS * 2);

// The same seed gives the same pool; another seed gives another order
const again = buildTermPool(extens, mobiles, POOL_RATIO, OPTIONS.seed);
assert.deepEqual(again, pool);
const other = buildTermPool(extens, mobiles, POOL_RATIO, 2);
assert.notDeepEqual(other.slice(0, 20), pool.slice(0, 20));

// The streams of different parts differ and repeat for the same parts
assert.equal(deriveSeed(1, 4, 7), deriveSeed(1, 4, 7));
assert.notEqual(deriveSeed(1, 4, 7), deriveSeed(1, 4, 8));
assert.equal(createRng(5)(), createRng(5)());

// Popularity: the repeat share of 100,000 draws is that of a directory
// asked far more often than it has terms
const draw = createSampler(pool, OPTIONS.exponent);
const rng = createRng(11);
const counts = new Map();
const DRAWS = 100000;
for (let i = 0; i < DRAWS; i++) {
  const { term } = draw(rng);
  counts.set(term, (counts.get(term) ?? 0) + 1);
}
const repeatShare = 1 - counts.size / DRAWS;
assert.ok(
  repeatShare > 0.8 && repeatShare < 0.92,
  `repeat share ${repeatShare.toFixed(3)} is out of range`,
);
assert.ok(counts.size > 9000, `${counts.size} distinct terms`);
const top = Math.max(...counts.values()) / DRAWS;
assert.ok(top < 0.03, `top term share ${top.toFixed(4)} is too high`);

// A burst has 7 to 12 terms, is repeatable, and keeps most of the user's list
const burst = createBurstGenerator(pool, OPTIONS);
const first = burst(0, 3);
assert.ok(first.length >= 7 && first.length <= 12);
assert.deepEqual(burst(0, 3), first);
let kept = 0;
let total = 0;
for (let iteration = 1; iteration <= 200; iteration++) {
  const a = burst(iteration, 3);
  const b = burst(iteration + 1000, 3);
  assert.equal(a.length, b.length, "a user's burst size is stable");
  a.forEach((entry, i) => {
    total += 1;
    kept += entry.term === b[i].term ? 1 : 0;
  });
}
// Two bursts both keep a term with probability 0.75 * 0.75, plus matches by chance
assert.ok(kept / total > 0.45 && kept / total < 0.7, `kept ${kept / total}`);

// The cold term is a hit that is far down the popularity order
const cold = coldTerm(pool);
assert.ok(cold.hit);
assert.equal(pool.lastIndexOf(cold) >= pool.length / 2, true);

console.log(
  `ok: ${pool.length} terms, ${counts.size} distinct in ${DRAWS} draws, repeat share ${repeatShare.toFixed(3)}`,
);
