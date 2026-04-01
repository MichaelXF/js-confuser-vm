## `0.0.4` Generated Opcodes

- Added new option `specializedOpcodes` which creates specialized opcodes for commonly used opcode+operand pairs.

```js
// Input Code
console.log("Hello world!");

// Before
// [3, 0],      LOAD_GLOBAL  "console"                  1:0-1:7
// [0, 1],      LOAD_CONST  "log"                       1:0-1:27
// [5],         GET_PROP                                1:0-1:27
// [0, 2],      LOAD_CONST  "Hello world!"              1:12-1:26
// [12, 1],     CALL_METHOD  (1 args)                   1:0-1:27
// [14],        POP                                     1:0-1:28

// What the opcode "LOAD_GLOBAL" looks like:
case OP.LOAD_CONST:
    this._push(this.constants[this._operand()]);
    break;

// After
// [64],        LOAD_GLOBAL_0                           1:0-1:7
// [65],        LOAD_CONST_1                            1:0-1:27
// [5],         GET_PROP                                1:0-1:27
// [66],        LOAD_CONST_2                            1:12-1:26
// [67],        CALL_METHOD_1                           1:0-1:27
// [14],        POP                                     1:0-1:28

// What the opcode "LOAD_GLOBAL_0" (64) looks like:
case 64:
    // LOAD_GLOBAL_0 (specialized)
    this._push(this.globals[this.constants[0]]);
    break;
```

- Added new option `macroOpcodes` which combines multiple opcodes commonly used from your bytecode

```js
// Input Code
console.log("Hello world!");
console.log("Hello world!");

// Before
// [3, 0],      LOAD_GLOBAL  "console"                  1:0-1:7
// [0, 1],      LOAD_CONST  "log"                       1:0-1:27
// [5],         GET_PROP                                1:0-1:27
// [0, 2],      LOAD_CONST  "Hello world!"              1:12-1:26
// [12, 1],     CALL_METHOD  (1 args)                   1:0-1:27
// [14],        POP                                     1:0-1:28
// [3, 0],      LOAD_GLOBAL  "console"                  2:0-2:7
// [0, 1],      LOAD_CONST  "log"                       2:0-2:27
// [5],         GET_PROP                                2:0-2:27
// [0, 2],      LOAD_CONST  "Hello world!"              2:12-2:26
// [12, 1],     CALL_METHOD  (1 args)                   2:0-2:27
// [14],        POP                                     2:0-2:28

// After
// [64, 0, 1, 2], LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST  [0, 1, 2]
// [12, 1],     CALL_METHOD  (1 args)                   1:0-1:27
// [14],        POP                                     1:0-1:28
// [64, 0, 1, 2], LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST  [0, 1, 2]
// [12, 1],     CALL_METHOD  (1 args)                   2:0-2:27
// [14],        POP                                     2:0-2:28

// What the opcode "LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST" (64) looks like:
case 64:
{
    // LOAD_GLOBAL
    this._push(this.globals[this.constants[this._operand()]]);
    // LOAD_CONST
    this._push(this.constants[this._operand()]);
    // GET_PROP
    // Stack: [..., obj, key] -> [..., obj, obj[key]]
    // obj is PEEKED (not popped) - CALL_METHOD needs it as receiver
    var key = this._pop();
    var obj = this.peek();
    this._push(obj[key]);
    // LOAD_CONST
    this._push(this.constants[this._operand()]);
    break;
}
```

- Flattened the bytecode. Now, instructions can read as many operands as needed, and it's unclear to distinguish between opcodes and operands:

```js
// Before (Operands clearly visible)
var BYTECODE = [[3, 0], [0, 1], [5, undefined], [0, 2], [12, 1], [14, undefined], [3, 0], [0, 1], [5, undefined], [0, 2], [12, 1], [14, undefined], [13, undefined]];

// After (Flattened with multi-operand instruction support)
var BYTECODE = [3, 0, 0, 1, 5, 0, 2, 12, 1, 14, 3, 0, 0, 1, 5, 0, 2, 12, 1, 14, 13];
```

- Changed the bytecode to use ushorts (16-bit ints) allowing a max value of 65,535 for opcodes and operands.


## `0.0.3` First update

- Created [Website Playground](https://development--confuser.netlify.app/vm)

- Added partial support for `try..catch` - The `finally` operator is not supported yet
- More ES5 coverage: getter/setters, debugger statement
- Improved compilation process:
  - Parsing: 
      JS -> AST
      Done by [@babel/parser](https://www.npmjs.com/package/@babel/parser)
  - Compilation: 
      AST -> IR bytecode. 
      This bytecode contains pseudo instructions and symbolic values for things like jump labels and constants
  - Transform passes (Assembler):
      Transform passes obfuscate and finally prepare the pseudo bytecode to be runnable. Here, all jump labels get converted into absolute PCs
  - Serializer:
      The bytecode is printed into the array form or encoded string if you have `encodeBytecode` enabled
  - Generating:
      This includes two sub-stages:
        - 1) Creating (another parsing->transforming->generating) the VM Runtime with the given options (randomized op codes, shuffled handlers)
        - 2) Placing the final bytecode into this VM Runtime

- Typescript is now transpiled for NPM



## `0.0.2` First release

