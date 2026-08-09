// A perfectly ordinary, *not* obfuscated program.
// `vm.js` must pass this straight through without touching or breaking it.

"use strict";

const GREETING = "hello";

function fib(n) {
  if (n < 2) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}

class Counter {
  constructor(start = 0) {
    this.value = start;
  }
  add(n) {
    this.value += n;
    return this;
  }
  get doubled() {
    return this.value * 2;
  }
}

const shout = (who) => `${GREETING}, ${who}!`.toUpperCase();

function classify(n) {
  switch (true) {
    case n < 0:
      return "negative";
    case n === 0:
      return "zero";
    default:
      return n % 2 === 0 ? "even" : "odd";
  }
}

function* take(iter, n) {
  let i = 0;
  for (const v of iter) {
    if (i++ >= n) return;
    yield v;
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const results = [];
for (let i = 0; i < 12; i++) results.push(fib(i));

const counter = new Counter(5);
counter.add(3).add(2);

const label = {
  name: "regular",
  tags: ["plain", "readable"],
  nested: { deep: { value: 42 } },
};

let caught = null;
try {
  JSON.parse("{ definitely not json");
} catch (e) {
  caught = e.constructor.name;
}

console.log(shout("world"));
console.log("fib:", results.join(","));
console.log("sum:", sum(results));
console.log("counter:", counter.value, counter.doubled);
console.log("classify:", [-1, 0, 3, 8].map(classify).join("/"));
console.log("take:", [...take(results, 4)].join(","));
console.log("label:", label.nested.deep.value, label.tags.length);
console.log("caught:", caught);
console.log("regex:", "a1b22c333".replace(/\d+/g, (m) => `<${m.length}>`));
console.log("done");
