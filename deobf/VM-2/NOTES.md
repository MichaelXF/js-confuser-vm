# VM-2 — state-array control-flow flattening

My analysis of `input.js` and how `vm.js` undoes it.

```bash
$ node vm.js input.js output.js
$ node test.js
```

---

## 1. What the sample actually is

`input.js` is one 300 KB line. Stripped of formatting there are only six
top-level declarations:

```js
function bb(n)            // integer hash (unused by the recovered program)
var bc = [12, -789, …]    // 108 numbers: a pool of "state" values
var bd = "sy>iF=+p#L(E|…" // concealed string table for the *dispatcher's* own strings
function be(seed, i, len) // decodes `len` characters of bd starting at i
function bf(a)            // sum of an array          <-- the program counter
function bg(a, b)         // bc.slice(a, b)
function bh(bb, bc = {…}, bd, bk)   // 294 KB: everything else
bh([...bg(0,10), -507, …]);         // entry point
```

`bh` is a **dispatcher**:

```js
function bh(bb, bc = {["aN"]:{}}, bd, bk) {
  while (bf(bb) !== 400) {
    switch (bf(bb)) {
      case bb[15] - -1276:                       // <- case test reads the state
        …real code…
        bb[10] += bb[14] - 2515, bb[13] += bb[0] - 609, …;   // <- the jump
        break;
      …135 more cases…
    }
  }
}
```

The trick is that the program counter is **the sum of an 84-element array**.
A basic block "jumps" by adding constants to a handful of slots, which moves the
sum to the value of the next block's `case`. The `case` labels themselves are
arithmetic over the *same* array (`bb[15] - -1276`), and every block carries
several decoy labels that can never match. Nothing here can be matched
syntactically — the array has to be interpreted.

Layered on top:

| technique | what it looks like |
|---|---|
| function outlining | every function becomes a state array reached through `function(...a){ return bh([<state>], scope, bd, a) }` |
| generic trampolines | `bh` is also used as a *call* helper: `bc.aW.a(<state>, scope, c, args)` runs whatever function `<state>` denotes, so the same dispatcher body serves every outlined function |
| variable masking | locals become properties of nested scope objects: `bc.aX.b.x.b.m.a` |
| string concealing | `be(seed, index, length)` for the dispatcher, and a second per-scope base91 layer over `bc.aN.j` for the payload |
| opaque predicates | `if (bb[25] == -(bb[62] + 823)) { break; }` — decidable, always dead |
| dead code | statements after `return` inside a case |

And the payload itself is a register VM (bytecode in a base64/base91 blob,
`this.k` memory, `this.y` frame pointer, `this.N[k[y+6]++]` operand fetch,
~128 opcode handlers) — see §4.

---

## 2. How `vm.js` undoes it

### 2.1 Detection

The dispatcher shape is the anchor:

```
while (SUM(X) !== <number>) { switch (SUM(X)) { … } }
```

with the *same* `SUM` identifier and the *same* `X` in both positions. Whichever
one-argument function appears most often in that position is the sum helper.
No dispatcher ⇒ the file is not this technique and the source is returned
byte-for-byte unchanged.

### 2.2 A constant environment

Every top-level declaration that contains no dispatcher is pure data or a pure
decoder (`bc`, `bd`, `bb`, `be`, `bf`, `bg`). They are evaluated once in a
`new Function` so that later folding can call them for real, instead of
reimplementing the obfuscator's arithmetic.

### 2.3 Symbolic execution → a real CFG

For a dispatcher with a known entry state:

* the **block key is the whole state array**, so decoys and aliasing collapse;
* `case` tests are evaluated against that array to pick the live case;
* `bb[i] += bb[j] - K` sequences are applied to the array, giving the successor;
* `if` tests that evaluate to a constant (opaque predicates) are folded away and
  only the live branch is followed;
* an `if` that genuinely depends on data forks the graph — that is a real edge;
* `return` / `throw` terminate; reaching the exit sum leaves the loop.

Everything else in the case body is *the original code* and is emitted, with all
state-array reads folded to literals.

### 2.4 Structuring

The recovered CFG is turned back into `if` / `else` / `while` /
`break` / `continue` with an iterative dominator + post-dominator analysis:
branch merges are the immediate post-dominator, natural loops come from back
edges, and only edges that actually leave a region get a label. On this sample
no block had to be duplicated (`fallbacks = 0`).

### 2.5 Un-outlining

`function(...a){ return bh([S], scope, bd, a) }` is replaced by a call to a
specialisation of `bh` for the state `S`.

Some of those specialisations turn out to be *generic*: their nested dispatcher
is driven by `bk[0]`, i.e. the state arrives with the arguments. Those are
recorded as trampolines and specialised **per call site** instead, with the
argument tuple threaded through — recursively, which is how arbitrarily deep
function nesting is encoded. Dispatchers declared as closures inside recovered
code are specialised in place so they keep their captured variables.

Specialisation is memoised per (dispatcher, state, argument tuple, scope), which
also makes recursive functions terminate. Because a call site can be reached
before the assignment that defines its trampoline, the whole walk is repeated
until the trampoline registry and the set of emitted functions stop changing.

### 2.6 Strings

The dispatcher's own `be(seed, i, len)` calls fold immediately — the decoder is
in the constant environment.

The payload's strings sit behind per-scope base91 decoders buried several
closures deep, so they are recovered by *observation*: the already recovered
program is run once in an inert sandbox (no filesystem, no network, no real DOM,
frozen clock and RNG) with every literal-argument call wrapped in a recorder. A
call site is folded only when

* it returned a **string**, and
* every observation of that callee agreed (same arguments ⇒ same string), and
* the callee is not `this.…` (those are the VM's operand readers, which look
  pure but advance the program counter).

Call sites in branches the probe never reached are resolved by invoking the
captured decoder directly. Finally the folded program is re-run and its
observable trace compared against the original; if anything differs, `vm.js`
falls back to the strictly observed set, and then to no folding at all. So the
worst case is a less readable output, never a wrong one.

### 2.7 Readability

* `(1, f)(x)` → `f(x)` when `f` provably never reads `this`
* repeated masked paths get a local: `var _s_m = bc.aX.b.x.b.m;`
* a second constant-folding round (the decoded strings unlock `typeof x === "number"`)
* statically dead branches removed — but only when nothing outside them uses the
  bindings they declare
* unreachable statements after a terminator dropped, with hoisted `var` /
  `function` bindings preserved
* `o["p"]` → `o.p`

---

## 3. Result of the first stage

```
301 631 bytes  ->  ~77 000 bytes
66 functions recovered from 309 basic blocks (8 outlining trampolines)
133 concealed strings decoded, 8 opaque branches removed, 0 dispatchers left
```

That intermediate stage is what `node vm.js input.js output.js --keep-vm`
writes, and it is where the interesting part starts, because what falls out of
it is a **register virtual machine**. §4 takes that apart too; the final
`output.js` is 873 bytes.

Both stages produce **byte-identical observable behaviour** to `input.js`;
`test.js` checks it by running them in the same deterministic sandbox and
diffing every console / DOM interaction.

What comes out of stage one is the JS-Confuser VM interpreter in ordinary
JavaScript, e.g. the base91 decoder:

```js
_s_m.a = ",L8Jd<;xB2ZHI74Fs)YQKz9T]>V=/jo@!ne[(COrXv?U`*&+1cASy$|lt\"NgRik…";
_s_m.b = "" + (bc.aX.b.w.b || "");
…
for (_s_m.h = 0; _s_m.h < _s_m.c; _s_m.h++) {
  _s_m.i = _s_m.a.indexOf(_s_m.b[_s_m.h]);
  if (_s_m.i === -1) continue;
  if (_s_m.g < 0) { _s_m.g = _s_m.i; } else {
    _s_m.g += _s_m.i * 91;
    _s_m.e |= _s_m.g << _s_m.f;
    _s_m.f += (_s_m.g & 8191) > 88 ? 13 : 14;
    do { _s_m.d.push(_s_m.e & 255); _s_m.e >>= 8; _s_m.f -= 8; } while (_s_m.f > 7);
    _s_m.g = -1;
  }
}
```

and the interpreter loop itself:

```js
var dP = this.y;             // frame pointer
var dQ = this.k;             // memory
var dR = this.N;             // bytecode
var dS = dQ[dP + 6];         // program counter
if (dS >= dR.length) break;
dQ[dP + 6] = dS + 1;
var dT = this.N[dS];         // opcode
dQ[dP + 0]++;
try { this[dT](); } catch (err) { …unwind to the nearest handler frame… }
```

---

## 3b. Is it the technique, or just this file?

`debug/make-sample.js` generates a *second* program with the same technique from
scratch — its own random pool, its own program-counter slot, expression case
labels, decoy labels, opaque predicates, an outlined function behind a
trampoline — encoding

```js
function dbl(n) { if (n > 2) return n * 10; return n * 2; }
var out = []; var i = 0;
while (i < 5) {
  if (i % 2 === 0) out.push("even" + dbl(i)); else out.push("odd" + i);
  i++;
}
console.log(out.join(","));
```

`vm.js` has never seen it, and gives back:

```js
function fn0(sc = {}, x, args) {
  var out = [];
  var i = 0;
  L1: while (true) {
    if (i < 5) {
      if (i % 2 === 0) { out.push("even" + sc.dbl(i)); } else { out.push("odd" + i); }
      i++;
      continue L1;
    } else { break L1; }
  }
  console.log(out.join(","));
}
function fn1(sc = {}, x, args) {
  var n = args[0];
  if (n > 2) { return n * 10; } else { return n * 2; }
}
fn0(function () { var sc = {}; sc.dbl = function (...a) { return fn1(sc, null, a); }; return sc; }());
```

`test.js` checks this every run — including that `out.join(",")` is *not*
folded away, which was a real bug: it takes a literal argument and is
deterministic in the sandbox, so an earlier version of the string recovery
happily replaced the whole call with `"even0,odd1,even4,odd3,even40"`. Decoders
now have to survive being re-invoked detached from any receiver before a call
site is folded.

---

## 4. The layer below: devirtualising the register machine

What stage one leaves behind is:

```js
Machine(U, C, t, H, N, q)      // U = constant pool   C = globals   N = bytecode
  this.k   memory (contiguous frames)
  this.y   frame pointer
frame: +0 counter +1 size +2 this +3 return slot +4 caller
       +5 function +6 pc +7 handler stack +8 register base
```

plus 128 opcode handlers reached as `this[N[pc++]]()`. `devirt.js` takes it
apart. It deliberately does **not** hard-code the instruction set - the opcode
numbering and the register assignments are randomised per build, so anything
literal would only ever work on this one file.

### 4.1 Reading the instruction set out of the interpreter

Each recovered handler is reduced to a canonical one-line shape: temporaries are
inlined, `this.k` / `this.y` / `this.k[this.y+8]` are renamed to `M` / `FP` / `B`,
and every operand read is tagged **in its original evaluation order** - including
the ones hidden inside `this.B()`, which quietly pulls a pool index and a
decryption key off the bytecode stream. What comes out is directly matchable:

```
op   180   M[B+@0]=M[B+@1];                  ->  mov   r@0, r@1
op   548   M[B+21]=M[B+21]+M[B+76];          ->  add   r21, r21, r76   (specialised)
op 45166   M[B+@0]=M[B+@1]===M[B+@2];        ->  seq   r@0, r@1, r@2
op  2806   if(!M[B+51]){M[FP+6]=13;}         ->  jz    r51, 13
op 53262   M[B+@0]=this.B(@1,0,@2);          ->  const r@0, pool[@1]^key
```

A table of ~30 templates (plus generated ones for every binary and unary
operator) covers all 128 handlers with none left over. The "randomised opcodes"
feature turns out to *help*: most handlers are the same template with the
register numbers baked in, so they carry no operands at all.

### 4.2 Disassembly

A worklist walk from each function entry, following jumps. Two things need care:

* **self-modifying bytecode.** One opcode decrypts a range of `N` into another
  range with a rolling key - the "Encode Bytecode" feature. Its operands are
  immediates, so the disassembler simply *runs* it when it reaches it, which it
  always does before the decrypted region executes.
* **variable length instructions.** Calls, `new`, array/object literals and
  closure creation read a count and then that many more words. The layouts came
  off the handlers: a call is `dst, fn, argc, args…`, with `argc === 10597911`
  meaning "one spread array"; a closure is
  `dst, pc, params, regs, ncells, rest, (own, index)…`.

### 4.3 Lifting, and the *third* layer

Lifting register operations to expressions is mechanical. The interesting part
is that the bytecode is **itself control-flow-flattened** - the original source
was flattened before it was compiled - so the disassembly is a chain of

```
r21 = 30969             ; state
r27 = r21 === 11897 ; if (r27) jmp …
r21 = r21 + 29814       ; move to the next state
```

The same idea that dissolved the outer layer dissolves this one: constant
propagate, and identify a block by its pc *plus* the values of the registers the
bytecode compares against constants. Those carry the flattening state;
everything else (loop counters, accumulators) is **joined** across incoming
edges by a fixpoint, so loops stay loops instead of unrolling.

Getting that split right is the whole trick. Specialising on every constant
unrolls the string loop 28 times; specialising on none leaves the dispatch
standing. Splitting on exactly the registers that appear in `===` / `!==`
comparisons gives both: the dispatch collapses and the loop survives.

Then local SSA (one name per assignment, live-out values handed back to the
shared register name), dominator-based structuring, and a readability pass that
folds `o.m.call(o, …)` into `o.m(…)`, merges copies and inlines single-use
temporaries.

### 4.4 The original program

```js
function __main() {
  var v10 = __fn_1004;
  var v2 = document.createElement("div");
  v2.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(v2);
  var v3 = v2.offsetWidth;
  var v4 = Date.now();
  var v5 = Math.floor(Math.random() * 1000000);
  var v9 = v4 + "|" + v5 + "|" + (v4 - 10000 + v5 * 5) % 97 + "|" +
           (v4 + v5 + v3) % 89 + "|" + (v5 + 1500) % 83;
  console.log(v9, v10(v9, v3 + v5));
}
function __fn_1004(v0, v1) {
  var v4, v5, v6;
  v4 = v1;
  v5 = "";
  v6 = 0;
  while (v6 < v0.length) {
    v4 = v4 + -1640531527 | 0;
    v5 = v5 + String.fromCharCode(v0.charCodeAt(v6) ^ (v4 ^ v4 >>> 13) & 65535);
    v6 = v6 + 1;
  }
  return v5;
}
__main();
```

**301 631 bytes -> 873 bytes**, producing exactly the same observable behaviour
as `input.js`: same console output, same DOM calls. Everything but the variable
names is back - a div is measured, three checksums are derived from the clock, a
random number and the measured width, and the result is printed alongside itself
run through a small stream cipher.

The devirtualised program is only used when it demonstrably matches: `vm.js`
runs both it and the machine it replaces in the same inert sandbox and compares
every observable effect, keeping the VM-level output if anything differs.

---

## 5. Files

| file | |
|---|---|
| `vm.js` | the deobfuscator (`node vm.js input.js output.js`, or `require('./vm.js')('input.js')`); `--keep-vm` stops after the flattening is removed |
| `devirt.js` | the devirtualiser for the register machine underneath |
| `test.js` | 30 checks: both stages, equivalence, string decoding, pass-through, edge cases |
| `regular.js` | an ordinary program that must survive untouched |
| `output.js` | the recovered source |
| `debug/` | analysis scaffolding kept from working the sample out |

---

## 6. Checked against the original

`original.js` was handed over *after* the solution was reached. Line by line:

| original | recovered | |
|---|---|---|
| `var div = document.createElement("div")` | `var v2 = document.createElement("div")` | ✔ |
| `div.style.width = "calc(100px + 20px * 2)"` | `v2.style.width = "calc(100px + 20px * 2)"` | ✔ |
| `document.body.appendChild(div)` | `document.body.appendChild(v2)` | ✔ |
| `var width = div.offsetWidth` | `var v3 = v2.offsetWidth` | ✔ |
| `var ts = Date.now()` | `var v4 = Date.now()` | ✔ |
| `var salt = Math.floor(Math.random() * 1000000)` | `var v5 = Math.floor(Math.random() * 1000000)` | ✔ |
| `modulo1 = (ts - 10000 + salt * 5) % 97` | `(v4 - 10000 + v5 * 5) % 97` | ✔ inlined |
| `modulo2 = (ts + salt + width) % 89` | `(v4 + v5 + v3) % 89` | ✔ inlined |
| `modulo3 = (salt + 1500) % 83` | `(v5 + 1500) % 83` | ✔ inlined |
| `ts + "\|" + salt + "\|" + …` | `v4 + "\|" + v5 + "\|" + …` | ✔ |
| `function xorEncode(str, key)` | `function __fn_1004(v0, v1)` | ✔ |
| `let k = key; let out = ""` | `v4 = v1; v5 = ""` | ✔ |
| `for (let i = 0; i < str.length; i++)` | `v6 = 0; while (v6 < v0.length) { … v6 = v6 + 1 }` | ✔ |
| `k = (k + 0x9e3779b9) \| 0` | `v4 = v4 + -1640531527 \| 0` | ✔ same value |
| `(k ^ (k >>> 13)) & 0xffff` | `(v4 ^ v4 >>> 13) & 65535` | ✔ |
| `out += String.fromCharCode(str.charCodeAt(i) ^ ks)` | `v5 = v5 + String.fromCharCode(v0.charCodeAt(v6) ^ …)` | ✔ |
| `console.log(antibotKey, xorEncode(antibotKey, width + salt))` | `console.log(v9, v10(v9, v3 + v5))` | ✔ |

Nothing is missing and nothing was invented. Four cosmetic differences, all of
them information the obfuscator destroyed or arithmetic that is provably equal:

1. **Names.** `div`, `width`, `ts`, `salt`, `xorEncode` became registers in the
   bytecode; `v2`, `v3`, `v4`, `v5`, `__fn_1004` is as close as anything can get.
2. **`0x9e3779b9` vs `-1640531527`.** The constant pool stores the int32 form.
   `(k + 0x9e3779b9) | 0 === (k + -1640531527) | 0` for every int32 `k` —
   `ToInt32` makes the 2³² difference vanish.
3. **`modulo1..3` inlined.** They are pure, single-use, and evaluated in the same
   left-to-right order, so the concatenation is identical.
4. **`if (true) { … }` and the top-level frame.** The `if (true)` was folded away
   before compilation; the block's `var`s live in `__main`'s frame rather than
   as globals, because that is what the VM's frame layout says. Nothing reads
   them from outside.

`let`/`const` came back as `var`. Nothing here captures the loop variable, so it
makes no difference; had something captured it, the compiler would have had to
emit per-iteration closure cells and the recovery would show those instead.

### The equivalence is tested, not asserted

The program's only inputs are the clock, the RNG and the measured width.
`test.js` sweeps **120 combinations** of them (0, 1, 2³¹−1, 2³², 1e15 for the
clock; 0 … 0.999999 for the RNG; 0, 1, 140, 65535, 2³¹−1 for the width) and
requires `original.js` and `output.js` to print byte-identical output for every
one — which exercises the 32-bit overflow in the cipher, `%` on negative
numbers, and the number→string coercions. It also checks `input.js` itself
against `original.js`, confirming the sample really is a build of that source.
