var FN = [
  {                       // FN[0] — sum
    name:       "sum",
    paramCount: 0,
    localCount: 3,
    upvalueDescriptors: [],
    bytecode: [
      [0, 0]      , // LOAD_CONST  0
      [2, 1]      , // STORE_LOCAL  slot[1]
      [0, 0]      , // LOAD_CONST  0
      [2, 2]      , // STORE_LOCAL  slot[2]
      [1, 2]      , // LOAD_LOCAL  slot[2]
      [1, 0]      , // LOAD_LOCAL  slot[0]
      [0, 1]      , // LOAD_CONST  "length"
      [35]        , // GET_PROP_COMPUTED
      [15]        , // LT
      [19, 25]    , // JUMP_IF_FALSE  25
      [1, 1]      , // LOAD_LOCAL  slot[1]
      [1, 0]      , // LOAD_LOCAL  slot[0]
      [1, 2]      , // LOAD_LOCAL  slot[2]
      [35]        , // GET_PROP_COMPUTED
      [6]         , // ADD
      [2, 1]      , // STORE_LOCAL  slot[1]
      [1, 1]      , // LOAD_LOCAL  slot[1]
      [14]        , // POP
      [1, 2]      , // LOAD_LOCAL  slot[2]
      [0, 2]      , // LOAD_CONST  1
      [6]         , // ADD
      [2, 2]      , // STORE_LOCAL  slot[2]
      [1, 2]      , // LOAD_LOCAL  slot[2]
      [14]        , // POP
      [18, 4]     , // JUMP  4
      [1, 1]      , // LOAD_LOCAL  slot[1]
      [13]        , // RETURN
      [0, 3]      , // LOAD_CONST  undefined
      [13]        , // RETURN
    ],
  },
];

var CONSTANTS = [
  /* 0 */  0,
  /* 1 */  "length",
  /* 2 */  1,
  /* 3 */  undefined,
  /* 4 */  FN[0],
  /* 5 */  "sum",
  /* 6 */  "console",
  /* 7 */  "log",
  /* 8 */  2,
  /* 9 */  3,
  /* 10 */  4,
  /* 11 */  6,
  /* 12 */  10,
];

var MAIN_BYTECODE = [
      [10, 4]     , // MAKE_CLOSURE  FN[0] → fn:sum
      [4, 5]      , // STORE_GLOBAL  "sum"
      [3, 6]      , // LOAD_GLOBAL  "console"
      [0, 7]      , // LOAD_CONST  "log"
      [5]         , // GET_PROP
      [3, 5]      , // LOAD_GLOBAL  "sum"
      [0, 2]      , // LOAD_CONST  1
      [0, 8]      , // LOAD_CONST  2
      [0, 9]      , // LOAD_CONST  3
      [0, 10]     , // LOAD_CONST  4
      [0, 11]     , // LOAD_CONST  6
      [0, 12]     , // LOAD_CONST  10
      [25]        , // UNARY_NEG
      [11, 6]     , // CALL  (6 args)
      [12, 1]     , // CALL_METHOD  (1 args)
      [14]        , // POP
];


// ── Opcodes ──────────────────────────────────────────────────────
var OP = {"LOAD_CONST":0,"LOAD_LOCAL":1,"STORE_LOCAL":2,"LOAD_GLOBAL":3,"STORE_GLOBAL":4,"GET_PROP":5,"ADD":6,"SUB":7,"MUL":8,"DIV":9,"MAKE_CLOSURE":10,"CALL":11,"CALL_METHOD":12,"RETURN":13,"POP":14,"LT":15,"GT":16,"EQ":17,"JUMP":18,"JUMP_IF_FALSE":19,"LTE":20,"GTE":21,"NEQ":22,"LOAD_UPVALUE":23,"STORE_UPVALUE":24,"UNARY_NEG":25,"UNARY_POS":26,"UNARY_NOT":27,"UNARY_BITNOT":28,"TYPEOF":29,"VOID":30,"TYPEOF_SAFE":31,"BUILD_ARRAY":32,"BUILD_OBJECT":33,"SET_PROP":34,"GET_PROP_COMPUTED":35,"MOD":36,"BAND":37,"BOR":38,"BXOR":39,"SHL":40,"SHR":41,"USHR":42,"JUMP_IF_FALSE_OR_POP":43,"JUMP_IF_TRUE_OR_POP":44,"DELETE_PROP":45,"IN":46,"INSTANCEOF":47,"LOAD_THIS":48,"NEW":49};

// ── Upvalue ───────────────────────────────────────────────────────
// While the outer frame is alive: reads/writes go to frame.locals[slot].
// After the outer frame returns (closed): reads/writes hit this.value.
function Upvalue(frame, slot) {
  this.frame  = frame;
  this.slot   = slot;
  this.closed = false;
  this.value  = undefined;
}
Upvalue.prototype.read  = function()  {
  return this.closed ? this.value : this.frame.locals[this.slot];
};
Upvalue.prototype.write = function(v) {
  if (this.closed) this.value = v;
  else this.frame.locals[this.slot] = v;
};
Upvalue.prototype.close = function()  {
  this.value  = this.frame.locals[this.slot];
  this.closed = true;
};

// ── Closure & Frame ───────────────────────────────────────────────
function Closure(fn) {
  this.fn = fn;
  this.upvalues = [];
  this.prototype = {};   // ← default prototype object for `new`
}

function Frame(closure, returnPc, parent, thisVal) {
  this.closure   = closure;
  this.locals    = new Array(closure.fn.localCount).fill(undefined);
  this.pc        = 0;
  this.returnPc  = returnPc;  // pc to resume in parent frame after RETURN
  this.parent    = parent;
  this.thisVal  = thisVal !== undefined ? thisVal : undefined; 
  this._newObj  = null;   // ← set by NEW so RETURN can see it
}

// ── VM ────────────────────────────────────────────────────────────
function VM(mainBytecode, constants, globals) {
  this.constants  = constants;
  this.globals    = globals;
  this.stack      = [];
  this.frameStack = [];
  this.openUpvalues = [];  // all currently open Upvalue objects across all frames

  var mainFn = { name:'<main>', paramCount:0, localCount:0, bytecode:mainBytecode };
  this.currentFrame = new Frame(new Closure(mainFn), null, null);
}

VM.prototype.push = function(v) { this.stack.push(v); };
VM.prototype.pop  = function()  { return this.stack.pop(); };
VM.prototype.peek = function()  { return this.stack[this.stack.length - 1]; };

VM.prototype.captureUpvalue = function(frame, slot) {
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

VM.prototype.closeUpvaluesFor = function(frame) {
  // Called on RETURN — close every upvalue that was pointing into this frame.
  // After this, closures that captured from the frame read from upvalue.value.
  this.openUpvalues = this.openUpvalues.filter(function(uv) {
    if (uv.frame === frame) { uv.close(); return false; }
    return true;
  });
};

VM.prototype.run = function() {
  while (true) {
    var frame = this.currentFrame;
    var bc    = frame.closure.fn.bytecode;
    if (frame.pc >= bc.length) break;

    var instr   = bc[frame.pc++];
    var op      = instr[0];
    var operand = instr[1];

    switch (op) {

      case OP.LOAD_CONST:
        this.push(this.constants[operand]);
        break;

      case OP.LOAD_LOCAL:
        this.push(frame.locals[operand]);
        break;

      case OP.STORE_LOCAL:
        frame.locals[operand] = this.pop();
        break;

      case OP.LOAD_GLOBAL:
        this.push(this.globals[this.constants[operand]]);
        break;

      case OP.STORE_GLOBAL:
        this.globals[this.constants[operand]] = this.pop();
        break;

      case OP.GET_PROP: {
        // Stack: [..., obj, key] → [..., obj, obj[key]]
        // obj is PEEKED (not popped) — CALL_METHOD needs it as receiver
        var key = this.pop();
        var obj = this.peek();
        this.push(obj[key]);
        break;
      }

      case OP.ADD: { var b = this.pop(); this.push(this.pop() + b); break; }
      case OP.SUB: { var b = this.pop(); this.push(this.pop() - b); break; }
      case OP.MUL: { var b = this.pop(); this.push(this.pop() * b); break; }
      case OP.DIV: { var b = this.pop(); this.push(this.pop() / b); break; }
      case OP.MOD:  { var b = this.pop(); this.push(this.pop() % b);   break; }
      case OP.BAND: { var b = this.pop(); this.push(this.pop() & b);   break; }
      case OP.BOR:  { var b = this.pop(); this.push(this.pop() | b);   break; }
      case OP.BXOR: { var b = this.pop(); this.push(this.pop() ^ b);   break; }
      case OP.SHL:  { var b = this.pop(); this.push(this.pop() << b);  break; }
      case OP.SHR:  { var b = this.pop(); this.push(this.pop() >> b);  break; }
      case OP.USHR: { var b = this.pop(); this.push(this.pop() >>> b); break; }

      case OP.LT: { var b = this.pop(); this.push(this.pop() < b);  break; }
      case OP.GT: { var b = this.pop(); this.push(this.pop() > b);  break; }
      case OP.EQ: { var b = this.pop(); this.push(this.pop() === b); break; }

      case OP.LTE: { var b = this.pop(); this.push(this.pop() <= b); break; }
      case OP.GTE: { var b = this.pop(); this.push(this.pop() >= b); break; }
      case OP.NEQ: { var b = this.pop(); this.push(this.pop() !== b); break; }

      case OP.IN: {
        var b = this.pop();
        this.push(this.pop() in b);
        break;
      }

      case OP.INSTANCEOF: {
        var ctor = this.pop();
        var obj  = this.pop();
        if (typeof ctor === 'function') {
          // Native constructor (e.g. Array, Date) — native instanceof is fine
          this.push(obj instanceof ctor);
        } else {
          // VM Closure — ctor.prototype was set by MAKE_CLOSURE / user assignment.
          // Walk obj's prototype chain looking for identity with ctor.prototype.
          var proto  = ctor.prototype;          // the .prototype property on the Closure
          var target = Object.getPrototypeOf(obj);
          var result = false;
          while (target !== null) {
            if (target === proto) { result = true; break; }
            target = Object.getPrototypeOf(target);
          }
          this.push(result);
        }
        break;
      }

      case OP.UNARY_NEG:    this.push(-this.pop());          break;
      case OP.UNARY_POS:    this.push(this.pop());          break;
      case OP.UNARY_NOT:    this.push(!this.pop());          break;
      case OP.UNARY_BITNOT: this.push(~this.pop());          break;
      case OP.TYPEOF:       this.push(typeof this.pop());    break;
      case OP.VOID:         this.pop(); this.push(undefined); break;

      case OP.TYPEOF_SAFE: {
        // operand is a const index holding the variable name string.
        // Mimics JS semantics: typeof undeclaredVar === "undefined" (no throw).
        var name = this.pop();  // LOAD_CONST pushed the name — consume it
        var val  = Object.prototype.hasOwnProperty.call(this.globals, name)
          ? this.globals[name]
          : undefined;
        this.push(typeof val);
        break;
      }

      case OP.JUMP:
        frame.pc = operand;
        break;

      case OP.JUMP_IF_FALSE:
        if (!this.pop()) frame.pc = operand;
        break;

      case OP.JUMP_IF_TRUE_OR_POP:
        // || semantics: if truthy, we're done — leave value, jump over RHS.
        // If falsy, discard it and fall through to evaluate RHS.
        if (this.peek()) { frame.pc = operand; } else { this.pop(); }
        break;

      case OP.JUMP_IF_FALSE_OR_POP:
        // && semantics: if falsy, we're done — leave value, jump over RHS.
        // If truthy, discard it and fall through to evaluate RHS.
        if (!this.peek()) { frame.pc = operand; } else { this.pop(); }
        break;

      case OP.MAKE_CLOSURE: {
        var fn       = this.constants[operand];
        var closure  = new Closure(fn);
        for (var i = 0; i < fn.upvalueDescriptors.length; i++) {
          var desc = fn.upvalueDescriptors[i];
          if (desc.isLocal) {
            // Capture directly from current frame's local slot
            closure.upvalues.push(this.captureUpvalue(frame, desc.index));
          } else {
            // Relay — take upvalue from the enclosing closure's list
            closure.upvalues.push(frame.closure.upvalues[desc.index]);
          }
        }
        this.push(closure);
        break;
      }

      case OP.LOAD_UPVALUE:
        this.push(frame.closure.upvalues[operand].read());
        break;

      case OP.STORE_UPVALUE:
        frame.closure.upvalues[operand].write(this.pop());
        break;

      case OP.BUILD_ARRAY: {
        // Pop `operand` values off the stack in reverse, assemble array.
        var elems = this.stack.splice(this.stack.length - operand);
        this.push(elems);
        break;
      }
      
      case OP.BUILD_OBJECT: {
        // Stack has: key0, val0, key1, val1 ... keyN, valN  (pushed left→right)
        // Pop all pairs and build the object.
        var pairs = this.stack.splice(this.stack.length - operand * 2);
        var o = {};
        for (var i = 0; i < pairs.length; i += 2) {
          o[pairs[i]] = pairs[i + 1];   // key at even index, val at odd
        }
        this.push(o);
        break;
      }
      case OP.SET_PROP: {
        // Stack: [..., obj, key, val]
        // Leaves val on stack — assignment is an expression in JS.
        var val = this.pop();
        var key = this.pop();
        var obj = this.pop();   
        obj[key] = val;
        this.push(val);          // assignment expression evaluates to the assigned value
        break;
      }
      case OP.GET_PROP_COMPUTED: {
        // Stack: [..., obj, key]  — key is a runtime value (nums[i])
        // Mirrors GET_PROP but pops the key that was pushed dynamically.
        var key = this.pop();
        var obj = this.pop();
        this.push(obj[key]);
        break;
      }
      case OP.DELETE_PROP: {
        var key = this.pop();
        var obj = this.pop();
        this.push(delete obj[key]);
        break;
      }

      case OP.CALL: {
        var args   = this.stack.splice(this.stack.length - operand);
        var callee = this.pop();
        if (typeof callee === 'function') {
          this.push(callee.apply(null, args));
        } else {
          var f = new Frame(callee, frame.pc, frame, undefined); // ← pass undefined as thisVal
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[callee.fn.paramCount] = args;  // ← arguments slot
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        }
        break;
      }

      case OP.CALL_METHOD: {
        var args     = this.stack.splice(this.stack.length - operand);
        var callee   = this.pop();
        var receiver = this.pop();  // left on stack by GET_PROP
        if (typeof callee === 'function') {
          this.push(callee.apply(receiver, args));
        } else {
          var f = new Frame(callee, frame.pc, frame, receiver); // ← pass receiver as thisVal
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[callee.fn.paramCount] = args;  // ← arguments slot
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        }
        break;
      }

      case OP.LOAD_THIS:
        this.push(frame.thisVal);
        break;

      case OP.NEW: {
        var args    = this.stack.splice(this.stack.length - operand);
        var callee  = this.pop();
        var newObj  = Object.create(callee.prototype || null);  // respects MyClass.prototype
        if (typeof callee === 'function') {
          // Native function constructor (e.g. new Date())
          var result = callee.apply(newObj, args);
          this.push((typeof result === 'object' && result !== null) ? result : newObj);
        } else {
          // VM closure constructor
          var f = new Frame(callee, frame.pc, frame, newObj);   // this = newObj
          f._newObj = newObj;                                    // remember for RETURN
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[callee.fn.paramCount] = args;  // ← arguments slot
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        }
        break;
      } 


      case OP.RETURN: {
        var retVal = this.pop();
        this.closeUpvaluesFor(frame);  // must happen before frame is abandoned
        if (this.frameStack.length === 0) return retVal;

        // new-call rule: primitive return → discard, use the constructed object instead
        if (frame._newObj !== null) {
          if (typeof retVal !== 'object' || retVal === null) retVal = frame._newObj;
        }

        this.currentFrame = this.frameStack.pop();
        this.push(retVal);
        break;
      }

      case OP.POP:
        this.pop();
        break;

      default:
        throw new Error('Unknown opcode: ' + op + ' at pc ' + (frame.pc - 1));
    }
  }
};

// ── Boot ─────────────────────────────────────────────────────────
var globals = { console: console, Math: Math, Date: Date, parseInt: parseInt, Object: Object };
var vm = new VM(MAIN_BYTECODE, CONSTANTS, globals);
vm.run();
