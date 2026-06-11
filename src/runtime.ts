import { OP_ORIGINAL as OP } from "./compiler.ts";
const BYTECODE = [];
const MAIN_START_PC = 0;
const MAIN_REG_COUNT = 0;
const CONSTANTS = [];
const ENCODE_BYTECODE = false;
const TIMING_CHECKS = false;
const SENTINELS = { CALL_SPREAD: 0 };
// The text above is not included in the compiled output - for type intellisense only
// @START

function base64ToBytes(s) {
  return typeof Buffer !== "undefined"
    ? Buffer.from(s, "base64")
    : Uint8Array.from(atob(s), function (c) {
        return c.charCodeAt(0);
      });
}

function decodeBytecode(s) {
  if (!ENCODE_BYTECODE) return s;

  var b = base64ToBytes(s);
  // Each slot is a u32 stored as 4 little-endian bytes.
  var r = new Uint32Array(b.length / 4);
  for (var i = 0; i < r.length; i++)
    r[i] =
      (b[i * 4] |
        (b[i * 4 + 1] << 8) |
        (b[i * 4 + 2] << 16) |
        (b[i * 4 + 3] << 24)) >>>
      0;
  return r;
}

// Closure map
// Maps shell functions -> inner Closure so the VM can fast-path back to the
// inner Closure instead of going through a sub-VM on internal calls.
// A WeakMap (rather than an own symbol property) keeps the link off the
// function object: escaped closures expose no own keys, and the map is
// non-enumerable, so host/attacker code can't pivot from a leaked function
// to VM internals. Module-scoped so it is shared across all VM/sub-VM instances.
var CLOSURE_MAP = new WeakMap();

// Upvalue — Lua/CPython style.
// While the outer frame is alive: reads/writes go to vm._regs[_absSlot].
// After the outer frame returns (closed): reads/writes hit this._value.
// _absSlot is the absolute index in VM._regs (frame._base + local slot).
function Upvalue(regs, absSlot) {
  this._regs = regs; // shared reference to VM._regs flat array
  this._absSlot = absSlot; // absolute index; stable as long as frame is alive
  this._closed = false;
  this._value = undefined;
}
Upvalue.prototype._read = function () {
  return this._closed ? this._value : this._regs[this._absSlot];
};
Upvalue.prototype._write = function (v) {
  if (this._closed) this._value = v;
  else this._regs[this._absSlot] = v;
};
Upvalue.prototype._close = function () {
  this._value = this._regs[this._absSlot];
  this._closed = true;
};

// Closure & Frame
function Closure(fn) {
  this.fn = fn;
  this.upvalues = [];
  this.prototype = {}; // <- default prototype object for `new`
}

// Frame — analogous to Lua CallInfo / CPython PyFrameObject.
// Does NOT own a register array; registers live in VM._regs[_base .. _base+regCount).
function Frame(closure, returnPc, parent, thisVal, retDstReg, base) {
  this.closure = closure;
  this._base = base; // absolute offset into VM._regs for this frame's r0
  this._pc = closure.fn.startPc;
  this._returnPc = returnPc;
  this._parent = parent;
  this.thisVal = thisVal !== undefined ? thisVal : undefined;
  this._retDstReg = retDstReg !== undefined ? retDstReg : 0;
  this._newObj = null;
  this._handlerStack = [];
}

// VM
function VM(bytecode, mainStartPc, mainRegCount, constants, globals) {
  this.bytecode = bytecode;
  this.constants = constants;
  this.globals = globals;
  this._frameStack = [];
  this._openUpvalues = [];

  // ── Flat register file (Lua-style) ────────────────────────────────────────
  // All frames share a single array.  Each Frame records its _base offset.
  // _regsTop is the next free slot (= base of the hypothetical next frame).
  // On CALL:   newBase = _regsTop; _regsTop += fn.regCount
  // On RETURN: _regsTop = frame._base   (pop the frame's register window)
  this._regs = new Array(mainRegCount).fill(undefined);
  this._regsTop = mainRegCount; // main frame occupies [0, mainRegCount)

  var mainFn = {
    paramCount: 0,
    regCount: mainRegCount,
    startPc: mainStartPc,
  };
  this._currentFrame = new Frame(
    new Closure(mainFn),
    null,
    null,
    undefined,
    0,
    0,
  );
}

// Consume the next slot from the flat bytecode stream and advance the PC.
// Called by opcode handlers to read each of their operands in order.
VM.prototype._operand = function () {
  return this.bytecode[this._currentFrame._pc++];
};

VM.prototype.captureUpvalue = function (frame, slot) {
  // Dedup by absolute slot — two closures capturing the same local share one Upvalue.
  var absSlot = frame._base + slot;
  for (var i = 0; i < this._openUpvalues.length; i++) {
    var uv = this._openUpvalues[i];
    if (!uv._closed && uv._absSlot === absSlot) return uv;
  }
  var uv = new Upvalue(this._regs, absSlot);
  this._openUpvalues.push(uv);
  return uv;
};

// Reads and decodes a constant from the pool.
// idx  — pool index (first operand of the constant pair emitted by resolveConstants).
// key  — conceal key (second operand). 0 means no concealment.
//
// For integers:  stored value is (original ^ key); XOR again to recover.
// For strings:   stored value is a base64 string containing u16 LE byte pairs.
//                Mirrors decodeBytecode: base64 → bytes → u16 LE → XOR with
//                (key + i) & 0xFFFF to recover the original char codes.
// idxIn, keyIn are passed in from specializedOpcodes when the operands are determined at compile time.
VM.prototype._constant = function (idxIn, keyIn) {
  var idx = idxIn ?? this._operand();
  var key = keyIn ?? this._operand();

  var v = this.constants[idx];
  if (!key) return v;
  if (typeof v === "number") return v ^ key;
  // String: base64-decode to u16 LE byte pairs, then XOR each code with (key+i).
  var b = base64ToBytes(v);
  var out = "";
  for (var i = 0; i < b.length / 2; i++) {
    var code = b[i * 2] | (b[i * 2 + 1] << 8); // u16 LE
    out += String.fromCharCode(code ^ ((key + i) & 0xffff));
  }
  return out;
};

VM.prototype._closeUpvaluesFor = function (frame) {
  // Called on RETURN — close every upvalue whose absolute slot falls within
  // this frame's register window [_base, _base + regCount).
  var lo = frame._base;
  var hi = frame._base + frame.closure.fn.regCount;
  this._openUpvalues = this._openUpvalues.filter(function (uv) {
    if (!uv._closed && uv._absSlot >= lo && uv._absSlot < hi) {
      uv._close();
      return false;
    }
    return true;
  });
};

VM.prototype._ensureRegisterWindow = function (base, regCount) {
  var end = base + regCount;
  while (this._regs.length < end) this._regs.push(undefined);
  for (var i = base; i < end; i++) this._regs[i] = undefined;
};

VM.prototype.run = function () {
  var now = () => {
    return performance.now();
  };

  var lastTime = now();

  while (true) {
    var frame = this._currentFrame;
    var bc = this.bytecode;
    if (frame._pc >= bc.length) break;

    var pc = frame._pc++;
    var op = this.bytecode[pc];
    var opcode = this.bytecode[pc];
    // console.log(
    //   "pc=" + pc,
    //   "opcode=" + opcode,
    //   Object.keys(OP).find((key) => OP[key] === opcode),
    // );

    // Debugging protection: Detects debugger by checking for >1s pauses which can only happen from debugger; or extremely slow sync tasks
    if (TIMING_CHECKS) {
      var currentTime = now();
      var isTamper = currentTime - lastTime > 1000;
      lastTime = currentTime;
      if (isTamper) {
        // Poison the bytecode
        for (var i = 0; i < this.bytecode.length; i++) this.bytecode[i] = 0;
        // Break the current state
        for (var i2 = frame._base; i2 < this._regsTop; i2++)
          this._regs[i2] = undefined;
        op = OP.JUMP;
        frame._pc = this.bytecode.length; // jump past end to halt
      }
    }

    try {
      var regs = this._regs;
      var base = frame._base;

      /* @SWITCH */
      switch (op) {
        case OP.LOAD_CONST: {
          var dst = this._operand();
          regs[base + dst] = this._constant();
          break;
        }

        case OP.LOAD_INT: {
          var dst = this._operand();
          regs[base + dst] = this._operand();
          break;
        }

        case OP.LOAD_GLOBAL: {
          var dst = this._operand();
          var globalName = this._constant();

          if (!(globalName in this.globals)) {
            throw new ReferenceError(`${globalName} is not defined`);
          }

          regs[base + dst] = this.globals[globalName];
          break;
        }

        case OP.LOAD_UPVALUE: {
          var dst = this._operand();
          regs[base + dst] = frame.closure.upvalues[this._operand()]._read();
          break;
        }

        case OP.LOAD_THIS: {
          var dst = this._operand();
          regs[base + dst] = frame.thisVal;
          break;
        }

        case OP.MOVE: {
          var dst = this._operand();
          regs[base + dst] = regs[base + this._operand()];
          break;
        }

        case OP.STORE_GLOBAL: {
          // globals[globalName] = regs[src]
          this.globals[this._constant()] = regs[base + this._operand()];
          break;
        }

        case OP.STORE_UPVALUE: {
          var uvIdx = this._operand();
          frame.closure.upvalues[uvIdx]._write(regs[base + this._operand()]);
          break;
        }

        case OP.GET_PROP: {
          // dst = regs[obj][regs[key]]
          var dst = this._operand();
          var obj = regs[base + this._operand()];
          var key = regs[base + this._operand()];
          regs[base + dst] = obj[key];
          break;
        }

        case OP.SET_PROP: {
          // regs[obj][regs[key]] = regs[val]
          var obj = regs[base + this._operand()];
          var key = regs[base + this._operand()];
          var val = regs[base + this._operand()];
          // Reflect.set performs [[Set]] without throwing on failure (non-strict mode behavior)
          Reflect.set(obj, key, val);
          break;
        }

        case OP.DELETE_PROP: {
          // regs[dst] = delete regs[obj][regs[key]]
          // The delete operator returns true if successful which is most cases
          var dst = this._operand();
          var obj = regs[base + this._operand()];
          var key = regs[base + this._operand()];
          regs[base + dst] = delete obj[key];
          break;
        }

        // Arithmetic  (dst, src1, src2)
        case OP.ADD: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a + regs[base + this._operand()];
          break;
        }
        case OP.SUB: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a - regs[base + this._operand()];
          break;
        }
        case OP.MUL: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a * regs[base + this._operand()];
          break;
        }
        case OP.DIV: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a / regs[base + this._operand()];
          break;
        }
        case OP.MOD: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a % regs[base + this._operand()];
          break;
        }
        case OP.BAND: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a & regs[base + this._operand()];
          break;
        }
        case OP.BOR: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a | regs[base + this._operand()];
          break;
        }
        case OP.BXOR: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a ^ regs[base + this._operand()];
          break;
        }
        case OP.SHL: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a << regs[base + this._operand()];
          break;
        }
        case OP.SHR: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a >> regs[base + this._operand()];
          break;
        }
        case OP.USHR: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a >>> regs[base + this._operand()];
          break;
        }

        // Comparison  (dst, src1, src2)
        case OP.LT: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a < regs[base + this._operand()];
          break;
        }
        case OP.GT: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a > regs[base + this._operand()];
          break;
        }
        case OP.LTE: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a <= regs[base + this._operand()];
          break;
        }
        case OP.GTE: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a >= regs[base + this._operand()];
          break;
        }
        case OP.EQ: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a === regs[base + this._operand()];
          break;
        }
        case OP.NEQ: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a !== regs[base + this._operand()];
          break;
        }
        case OP.LOOSE_EQ: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a == regs[base + this._operand()];
          break;
        }
        case OP.LOOSE_NEQ: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a != regs[base + this._operand()];
          break;
        }
        case OP.IN: {
          var dst = this._operand();
          var a = regs[base + this._operand()];
          regs[base + dst] = a in regs[base + this._operand()];
          break;
        }
        case OP.INSTANCEOF: {
          // regs[dst] = regs[obj] instanceof regs[ctor]
          var dst = this._operand();
          var obj = regs[base + this._operand()];
          var ctor = regs[base + this._operand()];
          if (typeof ctor === "function") {
            regs[base + dst] = obj instanceof ctor;
          } else {
            // TODO: Why is this needed?
            var proto = ctor.prototype;
            var target = Object.getPrototypeOf(obj);
            var result = false;
            while (target !== null) {
              if (target === proto) {
                result = true;
                break;
              }
              target = Object.getPrototypeOf(target);
            }
            regs[base + dst] = result;
          }
          break;
        }

        // Unary  (dst, src)
        case OP.UNARY_NEG: {
          var dst = this._operand();
          regs[base + dst] = -regs[base + this._operand()];
          break;
        }
        case OP.UNARY_POS: {
          var dst = this._operand();
          regs[base + dst] = +regs[base + this._operand()];
          break;
        }
        case OP.UNARY_NOT: {
          var dst = this._operand();
          regs[base + dst] = !regs[base + this._operand()];
          break;
        }
        case OP.UNARY_BITNOT: {
          var dst = this._operand();
          regs[base + dst] = ~regs[base + this._operand()];
          break;
        }
        case OP.TYPEOF: {
          var dst = this._operand();
          regs[base + dst] = typeof regs[base + this._operand()];
          break;
        }
        case OP.VOID: {
          var dst = this._operand();
          this._operand(); // consumes argument (intended)
          regs[base + dst] = undefined;
          break;
        }
        case OP.TYPEOF_SAFE: {
          // regs[dst] = typeof window[name]
          // Never throws ReferenceError, instead returns undefined for undeclared variables
          var dst = this._operand();
          var name = this._constant();
          var val = Object.prototype.hasOwnProperty.call(this.globals, name)
            ? this.globals[name]
            : undefined;
          regs[base + dst] = typeof val;
          break;
        }

        // Control flow
        case OP.JUMP:
          frame._pc = this._operand();
          break;

        case OP.JUMP_IF_FALSE: {
          var src = this._operand();
          var target = this._operand();
          if (!regs[base + src]) frame._pc = target;
          break;
        }

        case OP.JUMP_IF_TRUE: {
          // || short-circuit: if truthy, jump over RHS.
          var src = this._operand();
          var target = this._operand();
          if (regs[base + src]) frame._pc = target;
          break;
        }

        // Calls
        case OP.CALL: {
          // dst, calleeReg, argc, [argReg...]  (argc=-1 means next operand is spread-args array reg)
          var dst = this._operand();
          var callee = regs[base + this._operand()];
          var argc = this._operand();
          var args;
          if (argc === SENTINELS.CALL_SPREAD) {
            args = regs[base + this._operand()];
          } else {
            args = new Array(argc);
            for (var i = 0; i < argc; i++)
              args[i] = regs[base + this._operand()];
          }

          var closure = callee && CLOSURE_MAP.get(callee);
          if (closure) {
            var newBase = this._regsTop;
            this._ensureRegisterWindow(newBase, closure.fn.regCount);
            this._regsTop = newBase + closure.fn.regCount;
            var f = new Frame(
              closure,
              frame._pc,
              frame,
              this.globals,
              dst,
              newBase,
            );
            if (closure.fn.hasRest) {
              var restSlot = closure.fn.paramCount - 1;
              for (var i = 0; i < restSlot; i++)
                this._regs[newBase + i] = i < args.length ? args[i] : undefined;
              this._regs[newBase + restSlot] = args.slice(restSlot);
            } else {
              for (var i = 0; i < args.length && i < closure.fn.regCount; i++)
                this._regs[newBase + i] = args[i];
            }
            if (closure.fn.paramCount < closure.fn.regCount) {
              this._regs[newBase + closure.fn.paramCount] = args;
            }
            this._frameStack.push(this._currentFrame);
            this._currentFrame = f;
          } else {
            regs[base + dst] = callee.apply(null, args);
          }
          break;
        }

        case OP.CALL_METHOD: {
          // dst, receiverReg, calleeReg, argc, [argReg...]  (argc=SENTINELS.CALL_SPREAD means spread-args array reg)
          var dst = this._operand();
          var receiver = regs[base + this._operand()];
          var callee = regs[base + this._operand()];
          var argc = this._operand();
          var args;
          if (argc === SENTINELS.CALL_SPREAD) {
            args = regs[base + this._operand()];
          } else {
            args = new Array(argc);
            for (var i = 0; i < argc; i++)
              args[i] = regs[base + this._operand()];
          }

          var closure = callee && CLOSURE_MAP.get(callee);
          if (closure) {
            var newBase = this._regsTop;
            this._ensureRegisterWindow(newBase, closure.fn.regCount);
            this._regsTop = newBase + closure.fn.regCount;
            var f = new Frame(
              closure,
              frame._pc,
              frame,
              receiver,
              dst,
              newBase,
            );
            if (closure.fn.hasRest) {
              var restSlot = closure.fn.paramCount - 1;
              for (var i = 0; i < restSlot; i++)
                this._regs[newBase + i] = i < args.length ? args[i] : undefined;
              this._regs[newBase + restSlot] = args.slice(restSlot);
            } else {
              for (var i = 0; i < args.length && i < closure.fn.regCount; i++)
                this._regs[newBase + i] = args[i];
            }
            if (closure.fn.paramCount < closure.fn.regCount) {
              this._regs[newBase + closure.fn.paramCount] = args;
            }
            this._frameStack.push(this._currentFrame);
            this._currentFrame = f;
          } else {
            regs[base + dst] = callee.apply(receiver, args);
          }
          break;
        }

        case OP.NEW: {
          // dst, calleeReg, argc, [argReg...]  (argc=SENTINELS.CALL_SPREAD means spread-args array reg)
          var dst = this._operand();
          var callee = regs[base + this._operand()];
          var argc = this._operand();
          var args;
          if (argc === SENTINELS.CALL_SPREAD) {
            args = regs[base + this._operand()];
          } else {
            args = new Array(argc);
            for (var i = 0; i < argc; i++)
              args[i] = regs[base + this._operand()];
          }

          var closure = callee && CLOSURE_MAP.get(callee);
          if (closure) {
            var newObj = Object.create(closure.prototype || null);
            var newBase = this._regsTop;
            this._ensureRegisterWindow(newBase, closure.fn.regCount);
            this._regsTop = newBase + closure.fn.regCount;
            var f = new Frame(closure, frame._pc, frame, newObj, dst, newBase);
            if (closure.fn.hasRest) {
              var restSlot = closure.fn.paramCount - 1;
              for (var i = 0; i < restSlot; i++)
                this._regs[newBase + i] = i < args.length ? args[i] : undefined;
              this._regs[newBase + restSlot] = args.slice(restSlot);
            } else {
              for (var i = 0; i < args.length && i < closure.fn.regCount; i++)
                this._regs[newBase + i] = args[i];
            }
            if (closure.fn.paramCount < closure.fn.regCount) {
              this._regs[newBase + closure.fn.paramCount] = args;
            }
            f._newObj = newObj;
            this._frameStack.push(this._currentFrame);
            this._currentFrame = f;
          } else {
            // Reflect.construct is required - Object.create+apply does NOT set
            // internal slots ([[NumberData]], [[StringData]], etc.) for built-ins.
            regs[base + dst] = Reflect.construct(callee, args);
          }
          break;
        }

        case OP.RETURN: {
          var retVal = regs[base + this._operand()];
          this._closeUpvaluesFor(frame); // must happen before frame is abandoned

          // Zero out callee's register window to limit exposing runtime values
          var hi = frame._base + frame.closure.fn.regCount;
          for (var i = frame._base as number; i < hi; i++)
            this._regs[i] = undefined;
          this._regsTop = frame._base;

          if (this._frameStack.length === 0) return retVal; // main script returning

          // NewExpression: When invoking from the 'new' keyword, the newly constructed object is returned instead (if the original function doesn't return an object)
          if (frame._newObj !== null) {
            if (typeof retVal !== "object" || retVal === null)
              retVal = frame._newObj;
          }

          var parentFrame = this._frameStack.pop();
          this._regs[parentFrame._base + frame._retDstReg] = retVal;
          this._currentFrame = parentFrame;
          break;
        }

        case OP.THROW:
          throw regs[base + this._operand()];

        // Closures
        case OP.MAKE_CLOSURE: {
          // dst, startPc, paramCount, regCount, uvCount, hasRest, [isLocal, idx, ...]
          var dst = this._operand();
          var startPc = this._operand();
          var paramCount = this._operand();
          var regCount = this._operand();
          var uvCount = this._operand();
          var hasRest = this._operand(); // 1 if last param is a rest element

          var uvDescs = new Array(uvCount);
          for (var i = 0; i < uvCount; i++) {
            var isLocalRaw = this._operand();
            var uvIndex = this._operand();
            uvDescs[i] = { isLocal: isLocalRaw, _index: uvIndex };
          }

          var fn = {
            paramCount: paramCount,
            regCount: regCount,
            startPc: startPc,
            upvalueDescriptors: uvDescs,
            hasRest: hasRest,
          };

          var closure = new Closure(fn);
          for (var i = 0; i < uvDescs.length; i++) {
            var uvd = uvDescs[i];
            if (uvd.isLocal) {
              closure.upvalues.push(this.captureUpvalue(frame, uvd._index));
            } else {
              closure.upvalues.push(frame.closure.upvalues[uvd._index]);
            }
          }

          // Wrap in a native callable shell so host code (array methods,
          // test assertions, setTimeout, etc.) can invoke VM closures.
          // CLOSURE_MAP lets VM-internal CALL/NEW bypass the sub-VM entirely.
          var self = this;
          var shell = (function (c) {
            return function () {
              var args = Array.prototype.slice.call(arguments);
              var sub = new VM(
                self.bytecode,
                0,
                c.fn.regCount,
                self.constants,
                self.globals,
              );
              var f = new Frame(
                c,
                null,
                null,
                this == null ? self.globals : this,
                0,
                0,
              );
              sub._currentFrame = f;
              if (c.fn.hasRest) {
                var restSlot = c.fn.paramCount - 1;
                for (var i = 0; i < restSlot; i++)
                  sub._regs[i] = i < args.length ? args[i] : undefined;
                sub._regs[restSlot] = args.slice(restSlot);
              } else {
                for (var i = 0; i < args.length && i < c.fn.regCount; i++)
                  sub._regs[i] = args[i];
              }
              if (c.fn.paramCount < c.fn.regCount) {
                sub._regs[c.fn.paramCount] = args;
              }
              return sub.run();
            };
          })(closure);
          CLOSURE_MAP.set(shell, closure);
          shell.prototype = closure.prototype; // unified prototype for new/instanceof
          regs[base + dst] = shell;
          break;
        }

        // Collections
        case OP.BUILD_ARRAY: {
          // dst, count, [elemReg...]
          var dst = this._operand();
          var count = this._operand();
          var elems = new Array(count);
          for (var i = 0; i < count; i++)
            elems[i] = regs[base + this._operand()];
          regs[base + dst] = elems;
          break;
        }

        case OP.BUILD_OBJECT: {
          // dst, pairCount, [keyReg, valReg, ...]
          var dst = this._operand();
          var pairCount = this._operand();
          var o = {};
          for (var i = 0; i < pairCount; i++) {
            var key = regs[base + this._operand()];
            var val = regs[base + this._operand()];
            o[key] = val;
          }
          regs[base + dst] = o;
          break;
        }

        // Object methods (getters / setters)
        case OP.DEFINE_GETTER: {
          // obj, key, fn
          var obj = regs[base + this._operand()];
          var key = regs[base + this._operand()];
          var getterFn = regs[base + this._operand()];
          var existingDesc = Object.getOwnPropertyDescriptor(obj, key);
          var getDesc: PropertyDescriptor = {
            get: getterFn,
            configurable: true,
            enumerable: true,
          };
          if (existingDesc && typeof existingDesc.set === "function") {
            getDesc.set = existingDesc.set;
          }
          Object.defineProperty(obj, key, getDesc);
          break;
        }

        case OP.DEFINE_SETTER: {
          // obj, key, fn
          var obj = regs[base + this._operand()];
          var key = regs[base + this._operand()];
          var setterFn = regs[base + this._operand()];
          var existingDesc = Object.getOwnPropertyDescriptor(obj, key);
          var setDesc: PropertyDescriptor = {
            set: setterFn,
            configurable: true,
            enumerable: true,
          };
          if (existingDesc && typeof existingDesc.get === "function") {
            setDesc.get = existingDesc.get;
          }
          Object.defineProperty(obj, key, setDesc);
          break;
        }

        // ── For-in iteration ──────────────────────────────────────────────────
        case OP.FOR_IN_SETUP: {
          // dst, src — build iterator object from enumerable keys of regs[src]
          var dst = this._operand();
          var obj = regs[base + this._operand()];
          var keys = [];
          if (obj !== null && obj !== undefined) {
            var seen = Object.create(null);
            var cur = Object(obj); // box primitives
            while (cur !== null) {
              var ownNames = Object.getOwnPropertyNames(cur);
              for (var i = 0; i < ownNames.length; i++) {
                var k = ownNames[i];
                if (!(k in seen)) {
                  seen[k] = true;
                  var propDesc = Object.getOwnPropertyDescriptor(cur, k);
                  if (propDesc && propDesc.enumerable) {
                    keys.push(k);
                  }
                }
              }
              cur = Object.getPrototypeOf(cur);
            }
          }
          regs[base + dst] = { _keys: keys, i: 0 };
          break;
        }

        case OP.FOR_IN_NEXT: {
          // dst, iterReg, exitTarget
          // Advances iterator; writes next key to dst, or jumps to exitTarget when done.
          var dst = this._operand();
          var iter = regs[base + this._operand()];
          var exitTarget = this._operand();
          if (iter.i >= iter._keys.length) {
            frame._pc = exitTarget;
          } else {
            regs[base + dst] = iter._keys[iter.i++];
          }
          break;
        }

        // ── Exception handling ────────────────────────────────────────────────
        case OP.TRY_SETUP: {
          // handlerPc, exceptionReg — push exception handler record onto current frame.
          frame._handlerStack.push({
            handlerPc: this._operand(),
            exceptionReg: this._operand(),
            frameStackDepth: this._frameStack.length,
          });
          break;
        }

        case OP.TRY_END: {
          // Normal exit from a try block — disarm the top handler record
          // (works for both catch and finally regions; they share the stack).
          frame._handlerStack.pop();
          break;
        }

        case OP.FINALLY_SETUP: {
          // finallyPc, contReg, payloadReg, throwPad
          // Arm a finalizer for the current region.  Unlike a catch record this
          // carries no exceptionReg; instead the continuation register (contReg)
          // receives the resume PC and payloadReg carries the in-flight value.
          frame._handlerStack.push({
            finallyPc: this._operand(),
            contReg: this._operand(),
            payloadReg: this._operand(),
            throwPad: this._operand(),
            frameStackDepth: this._frameStack.length,
          });
          break;
        }

        // Self-modifying bytecode
        case OP.PATCH: {
          // destPc, sliceStart, sliceEnd
          var destPc = this._operand();
          var sliceStart = this._operand();
          var sliceEnd = this._operand();
          for (var pi = sliceStart; pi < sliceEnd; pi++) {
            this.bytecode[destPc + (pi - sliceStart)] = this.bytecode[pi];
          }
          break;
        }

        case OP.JUMP_REG: {
          // Indirect jump: allows VM to jump based on runtime values.
          frame._pc = regs[base + this._operand()];
          break;
        }

        case OP.DEBUGGER: {
          debugger;
          break;
        }

        default:
          throw new Error(
            "Unknown opcode: " + op + " at pc " + (frame._pc - 1),
          );
      }
    } catch (err) {
      // Exception handler unwinding
      // Walk from the current frame upward until we find a frame that has an open exception handler (TRY_SETUP without a matching TRY_END).
      // For every frame we abandon along the way, close its captured upvalues.
      var handledFrame = null;
      var searchFrame = this._currentFrame;
      while (true) {
        if (searchFrame._handlerStack.length > 0) {
          handledFrame = searchFrame;
          break;
        }
        // No handler in this frame — abandon it and walk up.
        this._closeUpvaluesFor(searchFrame);
        this._regsTop = searchFrame._base;
        if (this._frameStack.length === 0) break;
        searchFrame = this._frameStack.pop();
        this._currentFrame = searchFrame;
      }

      if (!handledFrame) throw err; // if there's no handler, propagate back to host

      var h = handledFrame._handlerStack.pop();
      // Discard any call-frames that were pushed inside the protected region.
      this._frameStack.length = h.frameStackDepth;
      var hBase = handledFrame._base;
      if (h.exceptionReg !== undefined) {
        // catch region — deliver the exception to the catch binding and run it.
        this._regs[hBase + h.exceptionReg] = err;
        handledFrame._pc = h.handlerPc;
      } else {
        // finally region — run the finalizer with the exception pending, then
        // resume at its throw pad (which re-raises and continues unwinding).
        this._regs[hBase + h.contReg] = h.throwPad;
        this._regs[hBase + h.payloadReg] = err;
        handledFrame._pc = h.finallyPc;
      }
      this._regsTop = hBase + handledFrame.closure.fn.regCount;
      this._currentFrame = handledFrame;
    }
  }
};

/* @BOOT */ // <- This comment can't be removed!
var globals: any = globalThis;
if (typeof window !== "undefined") {
  globals.window = window;
  globals.document = typeof document !== "undefined" ? document : undefined;
}
if (typeof module !== "undefined") {
  globals.module = module;
  globals.exports = typeof exports !== "undefined" ? exports : undefined;
}

var vm = new VM(
  decodeBytecode(BYTECODE),
  MAIN_START_PC,
  MAIN_REG_COUNT,
  CONSTANTS,
  globals,
);
vm.run();
