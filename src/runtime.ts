import { OP_ORIGINAL as OP } from "./compiler.ts";
const BYTECODE = [];
const MAIN_START_PC = 0;
const MAIN_REG_COUNT = 0;
const CONSTANTS = [];
const ENCODE_BYTECODE = false;
const TIMING_CHECKS = false;
// The text above is not included in the compiled output - for type intellisense only
// @START

function decodeBytecode(s) {
  if (!ENCODE_BYTECODE) return s;

  var b =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "base64")
      : Uint8Array.from(atob(s), function (c) {
          return c.charCodeAt(0);
        });
  // Each slot is a u16 stored as 2 little-endian bytes.
  var r = new Uint16Array(b.length / 2);
  for (var i = 0; i < r.length; i++) r[i] = b[i * 2] | (b[i * 2 + 1] << 8);
  return r;
}

// Closure symbol
// Used to tag shell functions so the VM can fast-path back to the
// inner Closure instead of going through a sub-VM on internal calls.
var CLOSURE_SYM = Symbol(); // Nameless for obfuscation

// Upvalue
// While the outer frame is alive: reads/writes go to frame.regs[slot].
// After the outer frame returns (closed): reads/writes hit this._value.
function Upvalue(frame, slot) {
  this._frame = frame;
  this._slot = slot;
  this._closed = false;
  this._value = undefined;
}
Upvalue.prototype._read = function () {
  return this._closed ? this._value : this._frame.regs[this._slot];
};
Upvalue.prototype._write = function (v) {
  if (this._closed) this._value = v;
  else this._frame.regs[this._slot] = v;
};
Upvalue.prototype._close = function () {
  this._value = this._frame.regs[this._slot];
  this._closed = true;
};

// Closure & Frame
function Closure(fn) {
  this.fn = fn;
  this.upvalues = [];
  this.prototype = {}; // <- default prototype object for `new`
}

function Frame(closure, returnPc, parent, thisVal, retDstReg) {
  this.closure = closure;
  this.regs = new Array(closure.fn.regCount).fill(undefined);
  this._pc = closure.fn.startPc; // <- initialize from fn descriptor
  this._returnPc = returnPc; // pc to resume in parent frame after RETURN
  this._parent = parent;
  this.thisVal = thisVal !== undefined ? thisVal : undefined;
  this._retDstReg = retDstReg !== undefined ? retDstReg : 0; // register in parent to write return value
  this._newObj = null; // <- set by NEW so RETURN can see it
  this._handlerStack = []; // <- exception handlers pushed by TRY_SETUP
}

// VM
function VM(bytecode, mainStartPc, mainRegCount, constants, globals) {
  this.bytecode = bytecode;
  this.constants = constants;
  this.globals = globals;
  this._frameStack = [];
  this._openUpvalues = []; // all currently open Upvalue objects across all frames

  var mainFn = {
    paramCount: 0,
    regCount: mainRegCount,
    startPc: mainStartPc, // <- where main begins
  };
  this._currentFrame = new Frame(new Closure(mainFn), null, null, undefined, 0);
}

// Consume the next slot from the flat bytecode stream and advance the PC.
// Called by opcode handlers to read each of their operands in order.
VM.prototype._operand = function () {
  return this.bytecode[this._currentFrame._pc++];
};

VM.prototype.captureUpvalue = function (frame, slot) {
  // Reuse existing open upvalue for this frame+slot if one exists.
  // This is what makes two closures share the same mutable cell.
  for (var i = 0; i < this._openUpvalues.length; i++) {
    var uv = this._openUpvalues[i];
    if (uv._frame === frame && uv._slot === slot) return uv;
  }
  var uv = new Upvalue(frame, slot);
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
  var b =
    typeof Buffer !== "undefined"
      ? Buffer.from(v, "base64")
      : Uint8Array.from(atob(v), function (c) {
          return c.charCodeAt(0);
        });
  var out = "";
  for (var i = 0; i < b.length / 2; i++) {
    var code = b[i * 2] | (b[i * 2 + 1] << 8); // u16 LE
    out += String.fromCharCode(code ^ ((key + i) & 0xffff));
  }
  return out;
};

VM.prototype._closeUpvaluesFor = function (frame) {
  // Called on RETURN - close every upvalue that was pointing into this frame.
  // After this, closures that captured from the frame read from upvalue.value.
  this._openUpvalues = this._openUpvalues.filter(function (uv) {
    if (uv._frame === frame) {
      uv._close();
      return false;
    }
    return true;
  });
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
        frame.regs.fill(undefined);
        op = OP.JUMP;
        frame._pc = this.bytecode.length; // jump past end to halt
      }
    }

    try {
      /* @SWITCH */
      switch (op) {
        case OP.LOAD_CONST: {
          var dst = this._operand();
          frame.regs[dst] = this._constant();
          break;
        }

        case OP.LOAD_INT: {
          var dst = this._operand();
          frame.regs[dst] = this._operand();
          break;
        }

        case OP.LOAD_GLOBAL: {
          var dst = this._operand();
          var globalName = this._constant();

          if (!(globalName in this.globals)) {
            throw new ReferenceError(`${globalName} is not defined`);
          }

          frame.regs[dst] = this.globals[globalName];
          break;
        }

        case OP.LOAD_UPVALUE: {
          var dst = this._operand();
          frame.regs[dst] = frame.closure.upvalues[this._operand()]._read();
          break;
        }

        case OP.LOAD_THIS: {
          var dst = this._operand();
          frame.regs[dst] = frame.thisVal;
          break;
        }

        case OP.MOVE: {
          var dst = this._operand();
          frame.regs[dst] = frame.regs[this._operand()];
          break;
        }

        case OP.STORE_GLOBAL: {
          // nameIdx and key are consumed inline so the concealConstants runtime
          // transform can rewrite this._constant() consistently.
          this.globals[this._constant()] = frame.regs[this._operand()];
          break;
        }

        case OP.STORE_UPVALUE: {
          var uvIdx = this._operand();
          frame.closure.upvalues[uvIdx]._write(frame.regs[this._operand()]);
          break;
        }

        case OP.GET_PROP: {
          // dst = regs[obj][regs[key]]
          var dst = this._operand();
          var obj = frame.regs[this._operand()];
          var key = frame.regs[this._operand()];
          frame.regs[dst] = obj[key];
          break;
        }

        case OP.SET_PROP: {
          // regs[obj][regs[key]] = regs[val]
          var obj = frame.regs[this._operand()];
          var key = frame.regs[this._operand()];
          var val = frame.regs[this._operand()];
          // Reflect.set performs [[Set]] without throwing on failure,
          // correctly simulating sloppy-mode assignment from a strict-mode host.
          Reflect.set(obj, key, val);
          break;
        }

        case OP.DELETE_PROP: {
          var dst = this._operand();
          var obj = frame.regs[this._operand()];
          var key = frame.regs[this._operand()];
          frame.regs[dst] = delete obj[key];
          break;
        }

        // ── Arithmetic  (dst, src1, src2) ────────────────────────────────────
        case OP.ADD: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a + frame.regs[this._operand()];
          break;
        }
        case OP.SUB: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a - frame.regs[this._operand()];
          break;
        }
        case OP.MUL: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a * frame.regs[this._operand()];
          break;
        }
        case OP.DIV: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a / frame.regs[this._operand()];
          break;
        }
        case OP.MOD: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a % frame.regs[this._operand()];
          break;
        }
        case OP.BAND: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a & frame.regs[this._operand()];
          break;
        }
        case OP.BOR: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a | frame.regs[this._operand()];
          break;
        }
        case OP.BXOR: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a ^ frame.regs[this._operand()];
          break;
        }
        case OP.SHL: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a << frame.regs[this._operand()];
          break;
        }
        case OP.SHR: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a >> frame.regs[this._operand()];
          break;
        }
        case OP.USHR: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a >>> frame.regs[this._operand()];
          break;
        }

        // ── Comparison  (dst, src1, src2) ─────────────────────────────────────
        case OP.LT: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a < frame.regs[this._operand()];
          break;
        }
        case OP.GT: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a > frame.regs[this._operand()];
          break;
        }
        case OP.LTE: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a <= frame.regs[this._operand()];
          break;
        }
        case OP.GTE: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a >= frame.regs[this._operand()];
          break;
        }
        case OP.EQ: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a === frame.regs[this._operand()];
          break;
        }
        case OP.NEQ: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a !== frame.regs[this._operand()];
          break;
        }
        case OP.LOOSE_EQ: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a == frame.regs[this._operand()];
          break;
        }
        case OP.LOOSE_NEQ: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a != frame.regs[this._operand()];
          break;
        }
        case OP.IN: {
          var dst = this._operand();
          var a = frame.regs[this._operand()];
          frame.regs[dst] = a in frame.regs[this._operand()];
          break;
        }
        case OP.INSTANCEOF: {
          var dst = this._operand();
          var obj = frame.regs[this._operand()];
          var ctor = frame.regs[this._operand()];
          if (typeof ctor === "function") {
            frame.regs[dst] = obj instanceof ctor;
          } else {
            // VM Closure - walk prototype chain for identity with ctor.prototype.
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
            frame.regs[dst] = result;
          }
          break;
        }

        // ── Unary  (dst, src) ─────────────────────────────────────────────────
        case OP.UNARY_NEG: {
          var dst = this._operand();
          frame.regs[dst] = -frame.regs[this._operand()];
          break;
        }
        case OP.UNARY_POS: {
          var dst = this._operand();
          frame.regs[dst] = +frame.regs[this._operand()];
          break;
        }
        case OP.UNARY_NOT: {
          var dst = this._operand();
          frame.regs[dst] = !frame.regs[this._operand()];
          break;
        }
        case OP.UNARY_BITNOT: {
          var dst = this._operand();
          frame.regs[dst] = ~frame.regs[this._operand()];
          break;
        }
        case OP.TYPEOF: {
          var dst = this._operand();
          frame.regs[dst] = typeof frame.regs[this._operand()];
          break;
        }
        case OP.VOID: {
          var dst = this._operand();
          this._operand(); // consume src — evaluated for side-effects by compiler
          frame.regs[dst] = undefined;
          break;
        }
        case OP.TYPEOF_SAFE: {
          // dst, nameConstIdx — safe typeof for potentially-undeclared globals.
          var dst = this._operand();
          var name = this._constant();
          var val = Object.prototype.hasOwnProperty.call(this.globals, name)
            ? this.globals[name]
            : undefined;
          frame.regs[dst] = typeof val;
          break;
        }

        // ── Control flow ──────────────────────────────────────────────────────
        case OP.JUMP:
          frame._pc = this._operand();
          break;

        case OP.JUMP_IF_FALSE: {
          var src = this._operand();
          var target = this._operand();
          if (!frame.regs[src]) frame._pc = target;
          break;
        }

        case OP.JUMP_IF_TRUE: {
          // || short-circuit: if truthy, jump over RHS.
          var src = this._operand();
          var target = this._operand();
          if (frame.regs[src]) frame._pc = target;
          break;
        }

        // ── Calls ─────────────────────────────────────────────────────────────
        case OP.CALL: {
          // dst, calleeReg, argc, [argReg...]
          var dst = this._operand();
          var callee = frame.regs[this._operand()];
          var argc = this._operand();
          var args = new Array(argc);
          for (var i = 0; i < argc; i++) args[i] = frame.regs[this._operand()];

          if (callee && callee[CLOSURE_SYM]) {
            var c = callee[CLOSURE_SYM];
            var f = new Frame(c, frame._pc, frame, this.globals, dst);
            for (var i = 0; i < args.length; i++) f.regs[i] = args[i];
            f.regs[c.fn.paramCount] = args;
            this._frameStack.push(this._currentFrame);
            this._currentFrame = f;
          } else {
            frame.regs[dst] = callee.apply(null, args);
          }
          break;
        }

        case OP.CALL_METHOD: {
          // dst, receiverReg, calleeReg, argc, [argReg...]
          var dst = this._operand();
          var receiver = frame.regs[this._operand()];
          var callee = frame.regs[this._operand()];
          var argc = this._operand();
          var args = new Array(argc);
          for (var i = 0; i < argc; i++) args[i] = frame.regs[this._operand()];

          if (callee && callee[CLOSURE_SYM]) {
            var c = callee[CLOSURE_SYM];
            var f = new Frame(c, frame._pc, frame, receiver, dst);
            for (var i = 0; i < args.length; i++) f.regs[i] = args[i];
            f.regs[c.fn.paramCount] = args;
            this._frameStack.push(this._currentFrame);
            this._currentFrame = f;
          } else {
            frame.regs[dst] = callee.apply(receiver, args);
          }
          break;
        }

        case OP.NEW: {
          // dst, calleeReg, argc, [argReg...]
          var dst = this._operand();
          var callee = frame.regs[this._operand()];
          var argc = this._operand();
          var args = new Array(argc);
          for (var i = 0; i < argc; i++) args[i] = frame.regs[this._operand()];

          if (callee && callee[CLOSURE_SYM]) {
            var c = callee[CLOSURE_SYM];
            var newObj = Object.create(c.prototype || null);
            var f = new Frame(c, frame._pc, frame, newObj, dst);
            f._newObj = newObj;
            for (var i = 0; i < args.length; i++) f.regs[i] = args[i];
            f.regs[c.fn.paramCount] = args;
            this._frameStack.push(this._currentFrame);
            this._currentFrame = f;
          } else {
            // Reflect.construct is required - Object.create+apply does NOT set
            // internal slots ([[NumberData]], [[StringData]], etc.) for built-ins.
            frame.regs[dst] = Reflect.construct(callee, args);
          }
          break;
        }

        case OP.RETURN: {
          var retVal = frame.regs[this._operand()];
          this._closeUpvaluesFor(frame); // must happen before frame is abandoned

          if (this._frameStack.length === 0) return retVal; // main script returning

          // new-call rule: primitive return -> discard, use the constructed object instead
          if (frame._newObj !== null) {
            if (typeof retVal !== "object" || retVal === null)
              retVal = frame._newObj;
          }

          var parentFrame = this._frameStack.pop();
          parentFrame.regs[frame._retDstReg] = retVal;
          this._currentFrame = parentFrame;
          break;
        }

        case OP.THROW:
          throw frame.regs[this._operand()];

        // ── Closures ──────────────────────────────────────────────────────────
        case OP.MAKE_CLOSURE: {
          // dst, startPc, paramCount, regCount, uvCount, [isLocal, idx, ...]
          var dst = this._operand();
          var startPc = this._operand();
          var paramCount = this._operand();
          var regCount = this._operand();
          var uvCount = this._operand();

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
          // CLOSURE_SYM lets VM-internal CALL/NEW bypass the sub-VM entirely.
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
              );
              for (var i = 0; i < args.length; i++) f.regs[i] = args[i];
              f.regs[c.fn.paramCount] = args;
              sub._currentFrame = f;
              return sub.run();
            };
          })(closure);
          shell[CLOSURE_SYM] = closure;
          shell.prototype = closure.prototype; // unified prototype for new/instanceof
          frame.regs[dst] = shell;
          break;
        }

        // ── Collections ───────────────────────────────────────────────────────
        case OP.BUILD_ARRAY: {
          // dst, count, [elemReg...]
          var dst = this._operand();
          var count = this._operand();
          var elems = new Array(count);
          for (var i = 0; i < count; i++)
            elems[i] = frame.regs[this._operand()];
          frame.regs[dst] = elems;
          break;
        }

        case OP.BUILD_OBJECT: {
          // dst, pairCount, [keyReg, valReg, ...]
          var dst = this._operand();
          var pairCount = this._operand();
          var o = {};
          for (var i = 0; i < pairCount; i++) {
            var key = frame.regs[this._operand()];
            var val = frame.regs[this._operand()];
            o[key] = val;
          }
          frame.regs[dst] = o;
          break;
        }

        // ── Property definitions (getters / setters) ──────────────────────────
        case OP.DEFINE_GETTER: {
          // obj, key, fn
          var obj = frame.regs[this._operand()];
          var key = frame.regs[this._operand()];
          var getterFn = frame.regs[this._operand()];
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
          var obj = frame.regs[this._operand()];
          var key = frame.regs[this._operand()];
          var setterFn = frame.regs[this._operand()];
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
          var obj = frame.regs[this._operand()];
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
          frame.regs[dst] = { _keys: keys, i: 0 };
          break;
        }

        case OP.FOR_IN_NEXT: {
          // dst, iterReg, exitTarget
          // Advances iterator; writes next key to dst, or jumps to exitTarget when done.
          var dst = this._operand();
          var iter = frame.regs[this._operand()];
          var exitTarget = this._operand();
          if (iter.i >= iter._keys.length) {
            frame._pc = exitTarget;
          } else {
            frame.regs[dst] = iter._keys[iter.i++];
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
          // Normal exit from a try block — disarm the exception handler.
          frame._handlerStack.pop();
          break;
        }

        // ── Self-modifying bytecode ───────────────────────────────────────────
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
      // Exception handler unwinding (CPython-style frame walk, Lua-style upvalue close).
      // Walk from the current frame upward until we find a frame that has an open
      // exception handler (TRY_SETUP without a matching TRY_END).
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
        if (this._frameStack.length === 0) break;
        searchFrame = this._frameStack.pop();
        this._currentFrame = searchFrame;
      }

      if (!handledFrame) throw err; // no handler anywhere — propagate to host

      var h = handledFrame._handlerStack.pop();
      // Discard any call-frames that were pushed inside the try body.
      this._frameStack.length = h.frameStackDepth;
      // Write the caught exception directly into the designated register.
      handledFrame.regs[h.exceptionReg] = err;
      // Jump to the catch block.
      handledFrame._pc = h.handlerPc;
      this._currentFrame = handledFrame;
    }
  }
};

// Boot
var globals: any = {}; // global object for globals

// Always pull built-ins from globalThis so eval() scoping can't shadow them
// with a local `window` variable (e.g. the test harness fake window).
for (var k of Object.getOwnPropertyNames(globalThis)) {
  globals[k] = globalThis[k];
}
// If a window object is in scope (browser or test harness), capture it
// explicitly so VM code can read/write window.TEST_OUTPUT etc.
if (typeof window !== "undefined") {
  globals["window"] = window;
}

// Transfer common primitives
globals.undefined = undefined;
globals.Infinity = Infinity;
globals.NaN = NaN;

var vm = new VM(
  decodeBytecode(BYTECODE),
  MAIN_START_PC,
  MAIN_REG_COUNT,
  CONSTANTS,
  globals,
);
vm.run();
