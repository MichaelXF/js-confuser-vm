import { OP } from "./compiler.ts";
const BYTECODE = [];
const MAIN_START_PC = 0;
const CONSTANTS = [];
const PACK = false;
// The text above is not included in the compiled output - for type intellisense only
// @START

function decodeBytecode(s) {
  if (!PACK) return s;

  var b =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "base64")
      : Uint8Array.from(atob(s), function (c) {
          return c.charCodeAt(0);
        });
  var r = new Int32Array(b.length / 4);
  for (var i = 0; i < r.length; i++)
    r[i] =
      b[i * 4] |
      (b[i * 4 + 1] << 8) |
      (b[i * 4 + 2] << 16) |
      (b[i * 4 + 3] << 24);
  return r;
}

// ── Closure symbol ────────────────────────────────────────────────
// Used to tag shell functions so the VM can fast-path back to the
// inner Closure instead of going through a sub-VM on internal calls.
var CLOSURE_SYM = Symbol(); // Nameless for obfuscation

// ── Upvalue ───────────────────────────────────────────────────────
// While the outer frame is alive: reads/writes go to frame.locals[slot].
// After the outer frame returns (closed): reads/writes hit this.value.
function Upvalue(frame, slot) {
  this.frame = frame;
  this.slot = slot;
  this._closed = false;
  this._value = undefined;
}
Upvalue.prototype.read = function () {
  return this._closed ? this._value : this.frame.locals[this.slot];
};
Upvalue.prototype.write = function (v) {
  if (this._closed) this._value = v;
  else this.frame.locals[this.slot] = v;
};
Upvalue.prototype.close = function () {
  this._value = this.frame.locals[this.slot];
  this._closed = true;
};

// ── Closure & Frame ───────────────────────────────────────────────
function Closure(fn) {
  this.fn = fn;
  this.upvalues = [];
  this.prototype = {}; // ← default prototype object for \`new\`
}

function Frame(closure, returnPc, parent, thisVal?) {
  this.closure = closure;
  this.locals = new Array(closure.fn.localCount).fill(undefined);
  this.pc = closure.fn.startPc; // ← initialize from fn descriptor
  this.returnPc = returnPc; // pc to resume in parent frame after RETURN
  this.parent = parent;
  this.thisVal = thisVal !== undefined ? thisVal : undefined;
  this._newObj = null; // ← set by NEW so RETURN can see it
}

// ── VM ────────────────────────────────────────────────────────────
function VM(bytecode, mainStartPc, constants, globals) {
  this.bytecode = bytecode;
  this.constants = constants;
  this.globals = globals;
  this._stack = [];
  this.frameStack = [];
  this.openUpvalues = []; // all currently open Upvalue objects across all frames

  var mainFn = {
    paramCount: 0,
    localCount: 0,
    startPc: mainStartPc, // ← where main begins
  };
  this.currentFrame = new Frame(new Closure(mainFn), null, null);
}

VM.prototype._push = function (v) {
  this._stack.push(v);
};
VM.prototype._pop = function () {
  return this._stack.pop();
};
VM.prototype.peek = function () {
  return this._stack[this._stack.length - 1];
};

VM.prototype.captureUpvalue = function (frame, slot) {
  // Reuse existing open upvalue for this frame+slot if one exists.
  // This is what makes two closures share the same mutable cell.
  for (var i = 0; i < this.openUpvalues.length; i++) {
    var uv = this.openUpvalues[i];
    if (uv.frame === frame && uv.slot === slot) return uv;
  }
  var uv = new Upvalue(frame, slot);
  this.openUpvalues.push(uv);
  return uv;
};

VM.prototype.closeUpvaluesFor = function (frame) {
  // Called on RETURN — close every upvalue that was pointing into this frame.
  // After this, closures that captured from the frame read from upvalue.value.
  this.openUpvalues = this.openUpvalues.filter(function (uv) {
    if (uv.frame === frame) {
      uv.close();
      return false;
    }
    return true;
  });
};

VM.prototype.run = function () {
  var now = () => {
    return performance.now();
  };

  var t = now();

  while (true) {
    var frame = this.currentFrame;
    var bc = this.bytecode;
    if (frame.pc >= bc.length) break;

    var op, operand;
    var word = bc[frame.pc++];

    if (PACK) {
      op = word & 0xff;
      operand = word >>> 8;
    } else {
      op = word[0];
      operand = word[1];
    }

    // console.log(frame.pc - 1, op, operand);

    // Debugging protection
    var t2 = now();
    var isTamper = t2 - t > 1000;
    t = t2;
    if (isTamper) {
      op = OP.RETURN;
    }

    /* @SWITCH */
    switch (op) {
      case OP.LOAD_CONST:
        this._push(this.constants[operand]);
        break;

      case OP.LOAD_LOCAL:
        this._push(frame.locals[operand]);
        break;

      case OP.STORE_LOCAL:
        frame.locals[operand] = this._pop();
        break;

      case OP.LOAD_GLOBAL:
        this._push(this.globals[this.constants[operand]]);
        break;

      case OP.STORE_GLOBAL:
        this.globals[this.constants[operand]] = this._pop();
        break;

      case OP.GET_PROP: {
        // Stack: [..., obj, key] → [..., obj, obj[key]]
        // obj is PEEKED (not popped) — CALL_METHOD needs it as receiver
        var key = this._pop();
        var obj = this.peek();
        this._push(obj[key]);
        break;
      }

      case OP.ADD: {
        var b = this._pop();
        this._push(this._pop() + b);
        break;
      }
      case OP.SUB: {
        var b = this._pop();
        this._push(this._pop() - b);
        break;
      }
      case OP.MUL: {
        var b = this._pop();
        this._push(this._pop() * b);
        break;
      }
      case OP.DIV: {
        var b = this._pop();
        this._push(this._pop() / b);
        break;
      }
      case OP.MOD: {
        var b = this._pop();
        this._push(this._pop() % b);
        break;
      }
      case OP.BAND: {
        var b = this._pop();
        this._push(this._pop() & b);
        break;
      }
      case OP.BOR: {
        var b = this._pop();
        this._push(this._pop() | b);
        break;
      }
      case OP.BXOR: {
        var b = this._pop();
        this._push(this._pop() ^ b);
        break;
      }
      case OP.SHL: {
        var b = this._pop();
        this._push(this._pop() << b);
        break;
      }
      case OP.SHR: {
        var b = this._pop();
        this._push(this._pop() >> b);
        break;
      }
      case OP.USHR: {
        var b = this._pop();
        this._push(this._pop() >>> b);
        break;
      }

      case OP.LT: {
        var b = this._pop();
        this._push(this._pop() < b);
        break;
      }
      case OP.GT: {
        var b = this._pop();
        this._push(this._pop() > b);
        break;
      }
      case OP.EQ: {
        var b = this._pop();
        this._push(this._pop() === b);
        break;
      }

      case OP.LTE: {
        var b = this._pop();
        this._push(this._pop() <= b);
        break;
      }
      case OP.GTE: {
        var b = this._pop();
        this._push(this._pop() >= b);
        break;
      }
      case OP.NEQ: {
        var b = this._pop();
        this._push(this._pop() !== b);
        break;
      }
      case OP.LOOSE_EQ: {
        var b = this._pop();
        this._push(this._pop() == b);
        break;
      }
      case OP.LOOSE_NEQ: {
        var b = this._pop();
        this._push(this._pop() != b);
        break;
      }

      case OP.IN: {
        var b = this._pop();
        this._push(this._pop() in b);
        break;
      }

      case OP.INSTANCEOF: {
        var ctor = this._pop();
        var obj = this._pop();
        if (typeof ctor === "function") {
          // Native constructor (e.g. Array, Date) — native instanceof is fine
          this._push(obj instanceof ctor);
        } else {
          // VM Closure — ctor.prototype was set by MAKE_CLOSURE / user assignment.
          // Walk obj's prototype chain looking for identity with ctor.prototype.
          var proto = ctor.prototype; // the .prototype property on the Closure
          var target = Object.getPrototypeOf(obj);
          var result = false;
          while (target !== null) {
            if (target === proto) {
              result = true;
              break;
            }
            target = Object.getPrototypeOf(target);
          }
          this._push(result);
        }
        break;
      }

      case OP.UNARY_NEG:
        this._push(-this._pop());
        break;
      case OP.UNARY_POS:
        this._push(this._pop());
        break;
      case OP.UNARY_NOT:
        this._push(!this._pop());
        break;
      case OP.UNARY_BITNOT:
        this._push(~this._pop());
        break;
      case OP.TYPEOF:
        this._push(typeof this._pop());
        break;
      case OP.VOID:
        this._pop();
        this._push(undefined);
        break;

      case OP.TYPEOF_SAFE: {
        // operand is a const index holding the variable name string.
        // Mimics JS semantics: typeof undeclaredVar === "undefined" (no throw).
        var name = this._pop(); // LOAD_CONST pushed the name — consume it
        var val = Object.prototype.hasOwnProperty.call(this.globals, name)
          ? this.globals[name]
          : undefined;
        this._push(typeof val);
        break;
      }

      case OP.JUMP:
        frame.pc = operand;
        break;

      case OP.JUMP_IF_FALSE:
        if (!this._pop()) frame.pc = operand;
        break;

      case OP.JUMP_IF_TRUE_OR_POP:
        // || semantics: if truthy, we're done — leave value, jump over RHS.
        // If falsy, discard it and fall through to evaluate RHS.
        if (this.peek()) {
          frame.pc = operand;
        } else {
          this._pop();
        }
        break;

      case OP.JUMP_IF_FALSE_OR_POP:
        // && semantics: if falsy, we're done — leave value, jump over RHS.
        // If truthy, discard it and fall through to evaluate RHS.
        if (!this.peek()) {
          frame.pc = operand;
        } else {
          this._pop();
        }
        break;

      case OP.MAKE_CLOSURE: {
        var fn = this.constants[operand];
        var closure = new Closure(fn);
        for (var i = 0; i < fn.upvalueDescriptors.length; i++) {
          var desc = fn.upvalueDescriptors[i];
          if (desc.isLocal) {
            // Capture directly from current frame's local slot
            closure.upvalues.push(this.captureUpvalue(frame, desc._index));
          } else {
            // Relay — take upvalue from the enclosing closure's list
            closure.upvalues.push(frame.closure.upvalues[desc._index]);
          }
        }
        // Wrap in a native callable shell so host code (array methods,
        // test assertions, setTimeout, etc.) can invoke VM closures.
        // CLOSURE_SYM lets VM-internal CALL/NEW bypass the sub-VM entirely.
        var self = this;
        var shell = (function (c) {
          return function () {
            var args = Array.prototype.slice.call(arguments);
            var sub = new VM(self.bytecode, 0, self.constants, self.globals);
            var f = new Frame(c, null, null, this);
            for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
            f.locals[c.fn.paramCount] = args;
            sub.currentFrame = f;
            return sub.run();
          };
        })(closure);
        shell[CLOSURE_SYM] = closure;
        shell.prototype = closure.prototype; // unified prototype for new/instanceof
        this._push(shell);
        break;
      }

      case OP.LOAD_UPVALUE:
        this._push(frame.closure.upvalues[operand].read());
        break;

      case OP.STORE_UPVALUE:
        frame.closure.upvalues[operand].write(this._pop());
        break;

      case OP.BUILD_ARRAY: {
        // Pop \`operand\` values off the stack in reverse, assemble array.
        var elems = this._stack.splice(this._stack.length - operand);
        this._push(elems);
        break;
      }

      case OP.BUILD_OBJECT: {
        // Stack has: key0, val0, key1, val1 ... keyN, valN  (pushed left→right)
        // Pop all pairs and build the object.
        var pairs = this._stack.splice(this._stack.length - operand * 2);
        var o = {};
        for (var i = 0; i < pairs.length; i += 2) {
          o[pairs[i]] = pairs[i + 1]; // key at even index, val at odd
        }
        this._push(o);
        break;
      }
      case OP.SET_PROP: {
        // Stack: [..., obj, key, val]
        // Leaves val on stack — assignment is an expression in JS.
        var val = this._pop();
        var key = this._pop();
        var obj = this._pop();
        obj[key] = val;
        this._push(val); // assignment expression evaluates to the assigned value
        break;
      }
      case OP.GET_PROP_COMPUTED: {
        // Stack: [..., obj, key]  — key is a runtime value (nums[i])
        // Mirrors GET_PROP but pops the key that was pushed dynamically.
        var key = this._pop();
        var obj = this._pop();
        this._push(obj[key]);
        break;
      }
      case OP.DELETE_PROP: {
        var key = this._pop();
        var obj = this._pop();
        this._push(delete obj[key]);
        break;
      }

      case OP.CALL: {
        var args = this._stack.splice(this._stack.length - operand);
        var callee = this._pop();
        if (callee && callee[CLOSURE_SYM]) {
          // VM closure — run directly in this VM, no sub-VM overhead
          var c = callee[CLOSURE_SYM];
          var f = new Frame(c, frame.pc, frame, undefined);
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[c.fn.paramCount] = args;
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        } else {
          // Native function
          this._push(callee.apply(null, args));
        }
        break;
      }

      case OP.CALL_METHOD: {
        var args = this._stack.splice(this._stack.length - operand);
        var callee = this._pop();
        var receiver = this._pop(); // left on stack by GET_PROP
        if (callee && callee[CLOSURE_SYM]) {
          // VM closure — run directly in this VM with receiver as this
          var c = callee[CLOSURE_SYM];
          var f = new Frame(c, frame.pc, frame, receiver);
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[c.fn.paramCount] = args;
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        } else {
          // Native method
          this._push(callee.apply(receiver, args));
        }
        break;
      }

      case OP.LOAD_THIS:
        this._push(frame.thisVal);
        break;

      case OP.NEW: {
        var args = this._stack.splice(this._stack.length - operand);
        var callee = this._pop();
        if (callee && callee[CLOSURE_SYM]) {
          // VM closure constructor — prototype is unified via shell.prototype = closure.prototype
          var c = callee[CLOSURE_SYM];
          var newObj = Object.create(c.prototype || null);
          var f = new Frame(c, frame.pc, frame, newObj);
          f._newObj = newObj;
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[c.fn.paramCount] = args;
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        } else {
          // Native constructor (e.g. new Error(), new Date()).
          // Reflect.construct is required — Object.create+apply does NOT set
          // internal slots ([[NumberData]], [[StringData]], etc.) for built-ins.
          this._push(Reflect.construct(callee, args));
        }
        break;
      }

      case OP.RETURN: {
        var retVal = this._pop();
        this.closeUpvaluesFor(frame); // must happen before frame is abandoned
        if (this.frameStack.length === 0) return retVal;

        // new-call rule: primitive return → discard, use the constructed object instead
        if (frame._newObj !== null) {
          if (typeof retVal !== "object" || retVal === null)
            retVal = frame._newObj;
        }

        this.currentFrame = this.frameStack.pop();
        this._push(retVal);
        break;
      }

      case OP.POP:
        this._pop();
        break;

      case OP.DUP:
        this._push(this.peek());
        break;

      case OP.THROW:
        throw this._pop();

      case OP.FOR_IN_SETUP: {
        // Pop the object; build an ordered list of all enumerable own+inherited
        // string keys by walking the prototype chain manually.
        // Uses getOwnPropertyNames (includes non-enumerable) + descriptor check,
        // so we never rely on Object.keys() and we handle inheritance correctly.
        var obj = this._pop();
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
        this._push({ keys: keys, i: 0 });
        break;
      }

      case OP.FOR_IN_NEXT: {
        // operand = jump target for the done case.
        // Pop the iterator; if exhausted jump to exit, otherwise push next key.
        var iter = this._pop();
        if (iter.i >= iter.keys.length) {
          frame.pc = operand;
        } else {
          this._push(iter.keys[iter.i++]);
        }
        break;
      }

      case OP.PATCH: {
        // Pop destination PC, then write constants[operand] (packed word array)
        // directly into this.bytecode starting at that PC.
        var destPc = this._pop();
        var words = this.constants[operand];

        if (PACK) {
          words = decodeBytecode(words);
        }

        for (var i = 0; i < words.length; i++) {
          this.bytecode[destPc + i] = words[i];
        }
        break;
      }

      default:
        throw new Error("Unknown opcode: " + op + " at pc " + (frame.pc - 1));
    }
  }
};

// ── Boot ─────────────────────────────────────────────────────────
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

var vm = new VM(decodeBytecode(BYTECODE), MAIN_START_PC, CONSTANTS, globals);
vm.run();
