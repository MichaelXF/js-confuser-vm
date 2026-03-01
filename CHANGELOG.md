## `1.0.3` First update

- Created [Website Playground]((https://development--confuser.netlify.app/vm))

- Added partial support for `try..catch` - The `finally` operator is not supported yet
- More ES5 coverage: getter/setters, debugger statement
- Improved compilation process:
  - Parsing: 
      JS -> AST
      Done by @babel/parser
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



## `1.0.2` First release

