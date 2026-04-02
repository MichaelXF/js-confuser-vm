## `0.0.7` Micro Opcodes

- Added new option `microOpcodes` which breaks opcodes into multiple sub-opcodes.

```js
// Input Code
console.log("Hello world!");

// Before
// [2, 1, 0, 0],        LOAD_GLOBAL  reg[1] = console                     1:0-1:7
// [0, 2, 1, 0],        LOAD_CONST  reg[2] = "log"                        1:0-1:27
// [8, 3, 1, 2],        GET_PROP  reg[3] = reg[1][reg[2]]                 1:0-1:27
// [0, 4, 2, 0],        LOAD_CONST  reg[4] = "Hello world!"               1:12-1:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = reg[3](recv=reg[1], 1 args) 1:0-1:27

// What the opcode "LOAD_CONST" looks like:
case OP.LOAD_CONST:
    var dst = this._operand();
    frame.regs[dst] = this._constant();
    break;

// After
// [60, 1],             MICRO_LOAD_GLOBAL_0  1                            1:0-1:7
// [61, 0, 0],          MICRO_LOAD_GLOBAL_1  [0, 0]                       
// [62],                MICRO_LOAD_GLOBAL_2                               
// [63],                MICRO_LOAD_GLOBAL_3                               
// [58, 2],             MICRO_LOAD_CONST_0  2                             1:0-1:27
// [59, 1, 0],          MICRO_LOAD_CONST_1  [1, 0]                        
// [64, 3],             MICRO_GET_PROP_0  3                               1:0-1:27
// [65, 1],             MICRO_GET_PROP_1  1                               
// [66, 2],             MICRO_GET_PROP_2  2                               
// [67],                MICRO_GET_PROP_3                                  
// [58, 4],             MICRO_LOAD_CONST_0  4                             1:12-1:26
// [59, 2, 0],          MICRO_LOAD_CONST_1  [2, 0]                        
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = reg[3](recv=reg[1], 1 args) 1:0-1:27

// What the opcodes "MICRO_LOAD_CONST_0" (58) and "MICRO_LOAD_CONST_1" (59) looks like:
case 58:
    // MICRO_LOAD_CONST_0
    this._internals[0] = this._operand();
    break;
case 59:
    // MICRO_LOAD_CONST_1
    frame.regs[this._internals[0]] = this._constant();
    break;
```

- Fixed `Macro Opcodes` possibly clashing variables when merging opcode handlers.

- Added support for update expressions on member expressions (`object.prop++`, `object.prop--`)

- Added support for Template literals (ES6 feature added for convenience)

- Added programs [cash.min.js](https://github.com/fabiospampinato/cash/blob/master/dist/cash.min.js) and [sha256.js](https://gist.github.com/bryanchow/1649353) to the test suite

## `0.0.6` Register based

- Switched from stack-based to register-based VM.

- `Specialized Opcodes` now applies to any fixed-size instruction, instead of just singular operands.
- - Specialized Opcodes never applies to N-sized instructions, such as `MAKE_CLOSURE`, `BUILD_ARRAY`, `CALL`, etc.

- `Macro Opcodes` can now include jumping/terminating opcodes if it's the last instruction in the sequence.

- Added new option `aliasedOpcodes` which creates duplicate opcodes, including variants with shuffled operand order.

```js
// Input Code
console.log("Hello, world!");

// Before
// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console                     1:0-1:7
// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        1:0-1:28
// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               1:0-1:28
// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello, world!"              1:12-1:27
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)1:0-1:28
// [0, 1, 3],           LOAD_CONST  reg[1] = undefined                    
// [45, 1],             RETURN  reg[1]                                

// What the opcode "LOAD_GLOBAL" looks like:
case OP.LOAD_GLOBAL:
    var dst = this._operand();
    frame.regs[dst] = this.globals[this.constants[this._operand()]];
    break;

// After
// [52040, 0, 1],       ALIAS_LOAD_GLOBAL_1_0  [0, 1]                     1:0-1:7
// [24862, 1, 2],       ALIAS_LOAD_CONST_1_0  [1, 2]                      1:0-1:28
// [25202, 1, 2, 3],    ALIAS_GET_PROP_1_2_0  [1, 2, 3]                   1:0-1:28
// [24862, 2, 4],       ALIAS_LOAD_CONST_1_0  [2, 4]                      1:12-1:27
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)1:0-1:28
// [24862, 3, 1],       ALIAS_LOAD_CONST_1_0  [3, 1]                      
// [51807, 1],          ALIAS_RETURN_0  1                                 

// What the opcode "ALIAS_LOAD_GLOBAL_1_0" (52040) looks like:
 case 52040:
    // ALIAS_LOAD_GLOBAL_1_0 (order: [1,0])
    let _unsortedOperands = [this._operand(), this._operand()];
    let _operands = [_unsortedOperands[1], _unsortedOperands[0]];
    var dst = _operands[0];
    frame.regs[dst] = this.globals[this.constants[_operands[1]]];
    break;
```

- Added new option `concealConstants` which XOR decrypts numbers and strings at runtime.

- Top level variables are now renamed and not exposed globally. To export a global function, you can use `window.MyGlobalFunction = function(){...}`

- Accessing an undeclared global variable will throw a ReferenceError

## `0.0.5` Generated Opcodes

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
case OP.LOAD_GLOBAL:
    this._push(this.globals[this.constants[this._operand()]]);
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

