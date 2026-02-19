// ================================================================
// VM OUTPUT — compiled from:
//   function add(x, y) { return x + y }
//   console.log(add(5, 10))
// ================================================================

// ── Opcodes ──────────────────────────────────────────────────────
const OP = {
  LOAD_CONST: 0, // push constants[operand] onto stack
  LOAD_LOCAL: 1, // push frame.locals[operand]
  STORE_LOCAL: 2, // pop  → frame.locals[operand]
  LOAD_GLOBAL: 3, // push globals[ constants[operand] ]
  STORE_GLOBAL: 4, // pop  → globals[ constants[operand] ]
  GET_PROP: 5, // pops key, PEEKS obj (keeps it!), pushes obj[key]
  ADD: 6, // pop b, pop a, push a + b
  MAKE_CLOSURE: 7, // wrap fn descriptor at constants[operand] into a live Closure
  CALL: 8, // plain call — no receiver, operand = argCount
  CALL_METHOD: 9, // method call — receiver sits below fn on stack, operand = argCount
  RETURN: 10, // pop return value, restore parent frame
  POP: 11, // discard top of stack
};

// ── Function Descriptors ─────────────────────────────────────────
// These are static templates the compiler emits.
// MAKE_CLOSURE turns one into a live Closure object (with upvalue slots).

const FN = [
  {
    // FN[0] — add(x, y)
    name: "add",
    paramCount: 2, // args fill locals[0..paramCount-1] on call
    localCount: 2, // x = locals[0], y = locals[1]
    upvalueCount: 0, // captures nothing from outer scope
    bytecode: [
      //  [opcode,        operand]    // stack after
      [OP.LOAD_LOCAL, 0], // [x]
      [OP.LOAD_LOCAL, 1], // [x, y]
      [OP.ADD], // [x + y]
      [OP.RETURN], // [] — returns (x + y) to caller
    ],
  },
];

// ── Constant Pool ─────────────────────────────────────────────────
// Shared pool for the main script. Strings are name-keys for globals/props;
// numbers are literal values; FN[n] entries are function descriptors.

const CONSTANTS = [
  /* 0 */ FN[0], // function descriptor — consumed by MAKE_CLOSURE
  /* 1 */ "add", // global name for storing/loading the add closure
  /* 2 */ "console", // global name
  /* 3 */ "log", // property key for GET_PROP
  /* 4 */ 5, // first argument to add()
  /* 5 */ 10, // second argument to add()
];

// ── Main Script Bytecode ──────────────────────────────────────────
//
//  Annotated stack state shown after each instruction.
//  Stack grows right →
//
const MAIN_BYTECODE = [
  //  [opcode,           operand]   // stack after ↓
  [OP.MAKE_CLOSURE, 0], // [Closure(add)]
  [OP.STORE_GLOBAL, 1], // []                          globals["add"] = Closure(add)
  [OP.LOAD_GLOBAL, 2], // [console]
  [OP.LOAD_CONST, 3], // [console, "log"]
  [OP.GET_PROP], // [console, fn:log]           obj stays for CALL_METHOD
  [OP.LOAD_GLOBAL, 1], // [console, fn:log, Closure(add)]
  [OP.LOAD_CONST, 4], // [console, fn:log, Closure(add), 5]
  [OP.LOAD_CONST, 5], // [console, fn:log, Closure(add), 5, 10]
  [OP.CALL, 2], // [console, fn:log, 15]       add(5,10) called, returns 15
  [OP.CALL_METHOD, 1], // []                          console.log(15), this=console
  [OP.POP], // []                          discard undefined return value
];

// ── Data Structures ───────────────────────────────────────────────

class Closure {
  constructor(fn, upvalues = []) {
    this.fn = fn; // points back to a FN[] descriptor
    this.upvalues = upvalues; // [] here — add() captures nothing
  }
}

class Frame {
  // One Frame is created per function call.
  // `locals` is this frame's entire variable scope — no dynamic name lookup.
  // The compiler resolved every variable to a numeric slot at compile time.
  constructor(closure, returnAddr, parentFrame) {
    this.closure = closure;
    this.locals = new Array(closure.fn.localCount).fill(undefined);
    this.pc = 0; // program counter, local to this frame
    this.returnAddr = returnAddr; // pc to resume in parent after RETURN
    this.parentFrame = parentFrame;
  }
}

// ── VM ────────────────────────────────────────────────────────────

class VM {
  constructor(mainBytecode, constants, globals) {
    this.constants = constants;
    this.globals = globals;
    this.stack = [];
    this.frameStack = []; // saved parent frames while inside a call

    // Wrap the top-level script in a synthetic closure so it runs through
    // the exact same Frame/RETURN machinery as any other function call.
    const mainFn = {
      name: "<main>",
      paramCount: 0,
      localCount: 0,
      upvalueCount: 0,
      bytecode: mainBytecode,
    };
    this.currentFrame = new Frame(new Closure(mainFn), null, null);
  }

  push(v) {
    this.stack.push(v);
  }
  pop() {
    return this.stack.pop();
  }
  peek(offset = 0) {
    return this.stack[this.stack.length - 1 - offset];
  }

  run() {
    while (true) {
      const frame = this.currentFrame;
      const bytecode = frame.closure.fn.bytecode;
      if (frame.pc >= bytecode.length) break;

      const instr = bytecode[frame.pc++]; // fetch & advance pc BEFORE executing
      const op = instr[0]; // so pc already points to the next instruction,
      const operand = instr[1]; // which doubles as the return address on CALL

      switch (op) {
        // ── Load / Store ──────────────────────────────────────

        case OP.LOAD_CONST: {
          // Pull a literal value or descriptor from the constant pool.
          this.push(this.constants[operand]);
          break;
        }

        case OP.LOAD_LOCAL: {
          // Read a variable from the current frame's slot array.
          // 'operand' is a compile-time slot index, not a name string.
          this.push(frame.locals[operand]);
          break;
        }

        case OP.STORE_LOCAL: {
          frame.locals[operand] = this.pop();
          break;
        }

        case OP.LOAD_GLOBAL: {
          // constants[operand] is a string key (e.g. "console").
          // Globals are just a plain JS object the VM was booted with.
          const name = this.constants[operand];
          this.push(this.globals[name]);
          break;
        }

        case OP.STORE_GLOBAL: {
          const name = this.constants[operand];
          this.globals[name] = this.pop();
          break;
        }

        // ── Property Access ───────────────────────────────────

        case OP.GET_PROP: {
          // Stack before: [..., obj, key]
          // Stack after:  [..., obj, obj[key]]
          //
          // The OBJECT IS INTENTIONALLY LEFT ON THE STACK.
          // CALL_METHOD reads it as `this` after args are popped.
          // If you only need the value (not a method call), issue POP after.
          const key = this.pop(); // "log"
          const obj = this.peek(); // console — peek, don't pop
          this.push(obj[key]); // console.log (native fn)
          break;
        }

        // ── Arithmetic ────────────────────────────────────────

        case OP.ADD: {
          // Operands come off in reverse push order.
          const b = this.pop(); // y (pushed second)
          const a = this.pop(); // x (pushed first)
          this.push(a + b);
          break;
        }

        // ── Closures ─────────────────────────────────────────

        case OP.MAKE_CLOSURE: {
          // Wrap a static fn descriptor into a live Closure.
          // For `add`, upvalues = [] because it references no outer variables.
          // When the compiler emits MAKE_CLOSURE for an inner function that DOES
          // close over variables, it will have preceded this instruction with
          // CAPTURE_UPVALUE instructions to build the upvalue list.
          const fn = this.constants[operand]; // FN[0]
          this.push(new Closure(fn, []));
          break;
        }

        // ── Calls ─────────────────────────────────────────────

        case OP.CALL: {
          // Stack before: [..., callee, arg0, arg1, ..., argN]
          //                             └────── argCount ────┘
          const argCount = operand;
          const args = this.stack.splice(this.stack.length - argCount);
          const callee = this.pop();

          if (typeof callee === "function") {
            // Native JS function — execute immediately, push result.
            this.push(callee(...args));
          } else if (callee instanceof Closure) {
            // VM function — push a new Frame and continue the run() loop inside it.
            // frame.pc is already incremented past CALL (the fetch above did that),
            // so it naturally serves as our return address.
            const newFrame = new Frame(callee, frame.pc, frame);
            for (let i = 0; i < args.length; i++) {
              newFrame.locals[i] = args[i]; // args land in the first N local slots
            }
            this.frameStack.push(this.currentFrame);
            this.currentFrame = newFrame; // run() will now dispatch from newFrame.pc = 0
          }
          break;
        }

        case OP.CALL_METHOD: {
          // Stack before: [..., receiver, fn, arg0, ..., argN]
          // receiver was left in place by GET_PROP — consume it now as `this`.
          const argCount = operand;
          const args = this.stack.splice(this.stack.length - argCount);
          const callee = this.pop(); // console.log (native fn)
          const receiver = this.pop(); // console

          if (typeof callee === "function") {
            // Native: use .apply so `this` is correctly bound (console.log needs it).
            this.push(callee.apply(receiver, args));
          } else if (callee instanceof Closure) {
            // VM closure: `this` semantics are up to you. Simplest approach is
            // to ignore it (closures don't use `this`) or store receiver in the frame.
            const newFrame = new Frame(callee, frame.pc, frame);
            for (let i = 0; i < args.length; i++) newFrame.locals[i] = args[i];
            this.frameStack.push(this.currentFrame);
            this.currentFrame = newFrame;
          }
          break;
        }

        case OP.RETURN: {
          const retVal = this.pop();

          if (this.frameStack.length === 0) {
            // Returning from <main> — program is complete.
            return retVal;
          }

          // Restore the calling frame. Its pc is already past the CALL that
          // created us, so execution resumes at the correct next instruction.
          this.currentFrame = this.frameStack.pop();
          this.push(retVal); // return value lands on the caller's stack
          break;
        }

        // ── Stack Ops ─────────────────────────────────────────

        case OP.POP: {
          // Discard the top value (e.g. unused return value of console.log).
          this.pop();
          break;
        }

        default:
          throw new Error(`Unknown opcode: ${op} at pc ${frame.pc - 1}`);
      }
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────

const globals = Object.assign(Object.create(null), {
  console, // expose native console — GET_PROP/"log"/CALL_METHOD routes through it
  // window, document, etc. would be listed here
});

const vm = new VM(MAIN_BYTECODE, CONSTANTS, globals);
vm.run();
// → 15 printed to console
