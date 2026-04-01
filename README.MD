# JS Confuser VM

  [![NPM](https://img.shields.io/badge/NPM-%23000000.svg?style=for-the-badge&logo=npm&logoColor=white)](https://npmjs.com/package/js-confuser-vm) [![GitHub](https://img.shields.io/badge/github-%23121011.svg?style=for-the-badge&logo=github&logoColor=white)](https://github.com/MichaelXF/js-confuser-vm) [![Netlify](https://img.shields.io/badge/netlify-%23000000.svg?style=for-the-badge&logo=netlify&logoColor=#00C7B7)](https://development--confuser.netlify.app/vm)


- **Requires Node v24.13.1 or higher**
- ES5 support only. No complex features: async, generator, and even try..finally aren't supported.
- Experimental. Expect issues.
- [Try the web version.](https://development--confuser.netlify.app/vm)

### Installation

```shell
$ npm install js-confuser-vm
```

### Usage

```js
import JsConfuserVM from "js-confuser-vm";

JsConfuserVM.obfuscate(`
  function fibonacci(num){   
    var a = 0, b = 1, c = num;
    while (num-- > 1) {
      c = a + b;
      a = b;
      b = c;
    }
    return c;
  }

  for ( var i = 1; i <= 25; i++ ) {
    console.log(i, fibonacci(i))
  }
`, {
  target: "browser", // or "node"
  randomizeOpcodes: true, // randomize the opcode numbers?
  shuffleOpcodes: true, // shuffle order of opcode handlers in the runtime?
  encodeBytecode: true, // encode bytecode? when off, comments for instructions are added
  selfModifying: true, // do self-modifying bytecode for function bodies?
  macroOpcodes: true, // create combined opcodes for repeated instruction sequences?
  specializedOpcodes: true, // create specialized opcodes for commonly used opcode+operand pairs?
  timingChecks: true, // add timing checks to detect debuggers?
  minify: true // pass final output through Google Closure Compiler? (Renames VM class properties)
}).then(result => {
  console.log(result.code)
})

/*
var b=Symbol();function ea(a,k){this.B=a;this.G=k;this.H=!1;this.J=void 0}function fa(a){return a.H?a.J:a.B.g[a.G]}function ha(a,k){a.H?a.J=k:a.B.g[a.G]=k}function d(a){this.u=a;this.D=[];this.prototype={}}function g(a,k){this.K=a;this.g=Array(a.u.O).fill(void 0);this.j=a.u.P;this.V=k!==void 0?k:void 0;this.I=null;this.F=[]}function u(a,k,c){this.o=a;this.v=k;this.m=c;this.h=[];this.l=[];this.C=[];this.i=new g(new d({A:0,O:0,P:0}))}function w(a,k){a.h.push(k)}function y(a){return a.h.pop()}
function E(a){return a.h[a.h.length-1]}function R(a){return a.o[a.i.j++]}function ia(a,k,c){for(var p=0;p<a.C.length;p++){var v=a.C[p];if(v.B===k&&v.G===c)return v}v=new ea(k,c);a.C.push(v);return v}function S(a,k){a.C=a.C.filter(function(c){return c.B===k?(c.J=c.B.g[c.G],c.H=!0,!1):!0})}
function T(a){for(var k=performance.now();;){var c=a.i;if(c.j>=a.o.length)break;var p=a.o[c.j++],v=performance.now(),ja=v-k>1E3;k=v;if(ja){for(var e=0;e<a.o.length;e++)a.o[e]=0;p=18186;a.h=[]}try{switch(p){case 3078:var h=a.h.splice(a.h.length-R(a)),l=y(a);if(l&&l[b]){var q=l[b],W=Object.create(q.prototype||null),m=new g(q,W);m.I=W;for(e=0;e<h.length;e++)m.g[e]=h[e];m.g[q.u.A]=h;a.l.push(a.i);a.i=m}else w(a,Reflect.construct(l,h));break;case 60312:c.F.push({S:R(a),U:a.h.length,R:a.l.length});break;
case 39875:w(a,c.V);break;case 52854:w(a,fa(c.K.D[R(a)]));break;case 57982:var ka=y(a),t=y(a),n=y(a),x=Object.getOwnPropertyDescriptor(n,t);c={set:ka,configurable:!0,enumerable:!0};x&&typeof x.get==="function"&&(c.get=x.get);Object.defineProperty(n,t,c);break;case 24006:throw y(a);case 22876:w(a,a.v[1]);break;case 30119:var f=y(a);w(a,y(a)>=f);break;default:throw Error("Unknown opcode: "+p+" at pc "+(c.j-1));case 47627:f=y(a);w(a,y(a)===f);break;case 40726:h=a.h.splice(a.h.length-R(a));l=y(a);var z=
y(a);if(l&&l[b]){q=l[b];m=new g(q,z);for(e=0;e<h.length;e++)m.g[e]=h[e];m.g[q.u.A]=h;a.l.push(a.i);a.i=m}else w(a,l.apply(z,h));break;case 44825:var L=a.h.splice(a.h.length-R(a)*2);c={};for(e=0;e<L.length;e+=2)c[L[e]]=L[e+1];w(a,c);break;case 9764:f=y(a);w(a,y(a)<f);break;case 17188:w(a,a.m[a.v[R(a)]]);break;case 47335:var A=y(a);S(a,c);if(a.l.length===0)return A;c.I===null||typeof A==="object"&&A!==null||(A=c.I);a.i=a.l.pop();w(a,A);break;case 26437:c.g[2]=y(a);break;case 36615:c.F.pop();break;case 42717:h=
a.h.splice(a.h.length-1);if((l=y(a))&&l[b]){q=l[b];m=new g(q,a.m);for(e=0;e<h.length;e++)m.g[e]=h[e];m.g[q.u.A]=h;a.l.push(a.i);a.i=m}else w(a,l.apply(null,h));break;case 9310:w(a,c.g[0]);break;case 40942:t=y(a);n=E(a);w(a,n[t]);break;case 28991:a.m[a.v[R(a)]]=y(a);break;case 55626:c.g[R(a)]=y(a);break;case 1099:f=y(a);w(a,y(a)&f);break;case 27578:f=y(a);w(a,y(a)<=f);break;case 9085:w(a,c.g[2]);break;case 46808:var r=R(a);y(a)||(c.j=r);break;case 45706:f=y(a);w(a,y(a)^f);break;case 50889:h=a.h.splice(a.h.length-
2);l=y(a);z=y(a);if(l&&l[b]){q=l[b];m=new g(q,z);for(e=0;e<h.length;e++)m.g[e]=h[e];m.g[q.u.A]=h;a.l.push(a.i);a.i=m}else w(a,l.apply(z,h));break;case 30510:r=R(a);E(a)?c.j=r:y(a);break;case 43517:w(a,c.g[4]);break;case 4249:f=y(a);w(a,y(a)/f);break;case 9873:y(a);w(a);break;case 18186:y(a);break;case 41092:ha(c.K.D[R(a)],y(a));break;case 11897:r=R(a);var F=y(a);F.N>=F.M.length?c.j=r:w(a,F.M[F.N++]);break;case 4731:w(a,E(a));break;case 3252:w(a,typeof y(a));break;case 45288:f=y(a);w(a,y(a)%f);break;
case 33898:w(a,a.m[a.v[2]]);break;case 47394:w(a,c.g[R(a)]);break;case 2573:w(a,a.v[R(a)]);break;case 21702:debugger;break;case 36429:f=y(a);w(a,y(a)!==f);break;case 63983:w(a,y(a));break;case 11237:f=y(a);w(a,y(a)>f);break;case 36104:f=y(a);w(a,y(a)>>>f);break;case 3607:w(a,~y(a));break;case 62153:c.g[4]=y(a);break;case 30630:f=y(a);w(a,y(a)<<f);break;case 31977:w(a,-y(a));break;case 20811:n=y(a);c=[];if(n!==null&&n!==void 0)for(var X=Object.create(null),B=Object(n);B!==null;){var Y=Object.getOwnPropertyNames(B);
for(e=0;e<Y.length;e++){var G=Y[e];if(!(G in X)){X[G]=!0;var Z=Object.getOwnPropertyDescriptor(B,G);Z&&Z.enumerable&&c.push(G)}}B=Object.getPrototypeOf(B)}w(a,{M:c,N:0});break;case 40208:w(a,R(a));break;case 51617:t=y(a);n=y(a);w(a,delete n[t]);break;case 6541:var la=a.h.splice(a.h.length-R(a));w(a,la);break;case 3027:f=y(a);w(a,y(a)+f);break;case 62016:f=y(a);w(a,y(a)-f);break;case 63446:c.g[0]=y(a);break;case 27060:f=y(a);w(a,y(a)==f);break;case 60562:r=R(a);E(a)?y(a):c.j=r;break;case 55362:c.j=
9;break;case 7995:var H=y(a);t=y(a);n=y(a);Reflect.set(n,t,H);w(a,H);break;case 17850:var ma=y(a);t=y(a);n=y(a);x=Object.getOwnPropertyDescriptor(n,t);c={get:ma,configurable:!0,enumerable:!0};x&&typeof x.set==="function"&&(c.set=x.set);Object.defineProperty(n,t,c);break;case 54027:f=y(a);w(a,y(a)!=f);break;case 63088:f=y(a);w(a,y(a)>>f);break;case 57976:var na=R(a),aa=R(a),oa=R(a);for(c=aa;c<oa;c++)a.o[na+(c-aa)]=a.o[c];break;case 18659:h=a.h.splice(a.h.length-R(a));if((l=y(a))&&l[b]){q=l[b];m=new g(q,
a.m);for(e=0;e<h.length;e++)m.g[e]=h[e];m.g[q.u.A]=h;a.l.push(a.i);a.i=m}else w(a,l.apply(null,h));break;case 1407:r=42;y(a)||(c.j=r);break;case 26140:w(a,c.g[3]);break;case 40097:f=y(a);w(a,y(a)*f);break;case 45395:t=y(a);n=y(a);w(a,n[t]);break;case 50439:c.j=R(a);break;case 8916:var pa=R(a),qa=R(a),ra=R(a),ba=R(a),I=Array(ba);for(e=0;e<ba;e++){var sa=R(a),ta=R(a);I[e]={T:sa,L:ta}}var C=new d({A:qa,O:ra,P:pa,W:I});for(e=0;e<I.length;e++){var M=I[e];M.T?C.D.push(ia(a,c,M.L)):C.D.push(c.K.D[M.L])}var J=
a,P=function(D){return function(){for(var N=Array.prototype.slice.call(arguments),ca=new u(J.o,J.v,J.m),O=new g(D,this==null?J.m:this),K=0;K<N.length;K++)O.g[K]=N[K];O.g[D.u.A]=N;ca.i=O;return T(ca)}}(C);P[b]=C;P.prototype=C.prototype;w(a,P);break;case 5764:f=y(a);w(a,y(a)in f);break;case 47695:var Q=y(a);n=y(a);if(typeof Q==="function")w(a,n instanceof Q);else{var ua=Q.prototype;r=Object.getPrototypeOf(n);for(c=!1;r!==null;){if(r===ua){c=!0;break}r=Object.getPrototypeOf(r)}w(a,c)}break;case 39207:f=
y(a);w(a,y(a)|f);break;case 16865:a.m[a.v[0]]=y(a);break;case 10233:c.g[3]=y(a);break;case 11143:w(a,!y(a));break;case 17244:var da=y(a);H=Object.prototype.hasOwnProperty.call(a.m,da)?a.m[da]:void 0;w(a,typeof H)}}catch(D){c=null;for(p=a.i;;){if(p.F.length>0){c=p;break}S(a,p);if(a.l.length===0)break;p=a.l.pop();a.i=p}if(!c)throw D;p=c.F.pop();a.h.length=p.U;w(a,D);a.l.length=p.R;c.j=p.S;a.i=c}}}var U={},V;for(V of Object.getOwnPropertyNames(globalThis))U[V]=globalThis[V];
typeof window!=="undefined"&&(U.window=window);U.undefined=void 0;U.Infinity=Infinity;U.NaN=NaN;
T(new u(function(a){a=typeof Buffer!=="undefined"?Buffer.from(a,"base64"):Uint8Array.from(atob(a),function(p){return p.charCodeAt(0)});for(var k=new Uint16Array(a.length/2),c=0;c<k.length;c++)k[c]=a[c*2]|a[c*2+1]<<8;return k}("1CIrAAEABQAAAOFBXFk/cQIAeOINAFwAbQBK2XD2Ga8LugvTeOK6a8ZdC7qndT9xC7o7HyK5Fw4KR1OxeOIiAG0AdQChyZjrexK6azsfQPKEoOUr57h44i8AdQB8ABmvukXTC4SgJ5nGVNMLeOI6AHwAgwB2zoQWtGk/cSQmT7qHK9i2UwB9Ixxm0wvJ8v2pCkccZkVnfSMKR/2p+SccZgpHB8U2AHjiVwCDAIQAQPLnuA0KAwDnuGqEDQoEALprfwUkQwUADQoGAO6faoQkQwAAaoTdpsnGCkdqhHsSXFnTCz9xAgAKR0LYDQoHAEVnXFn5J14kyfJeJHsSXFlA8tb3XFnlK/2p"),["fibonacci",
1,"i",void 0,25,"console","log",0],U));
*/
```

### Features

- [x] functions: call, arguments, return
- [x] closures and nested functions
- [x] literals
- [x] binary expressions
- [x] unary expressions
- [x] update expressions
- [x] if statements
- [x] while, do-while, for loops
- [x] get property
- [x] logical expressions
- [x] array, object expression
- [x] function expression
- [x] default arguments in functions
- [x] sequence expression
- [x] conditional expression (ternary operator)
- [x] delete operator
- [x] in / instanceof
- [x] this, new expression
- [x] arguments
- [x] Infinity, NaN
- [x] break/continue
- [x] switch statement
- [x] throw statement
- [x] labeled statements
- [x] for..in loop
- [x] RegExp literals
- [x] try..catch
- [x] getter/setters
- [x] debugger;

### Missing

- [ ] try..finally
- [ ] with statement
- [ ] arguments.callee, argument parameter syncing   

### Hardening

- [x] opcode randomization per build
- [x] property name concealment of vm internals
- - Google Closure Compiler aggressively renames our class props
- [x] shuffled handler order
- [ ] dead handlers
- [ ] dead bytecode insertion
- [x] macro opcodes (Combine multiple opcodes into a "macro opcode")
- [x] specialized opcodes (Create specific opcodes for opcode+operand pairs)
- [x] encoded bytecode array
- [x] self-modifying bytecode
- [x] timing checks
- [ ] low-level bytecode obfuscations
- [ ] stack protection
- [ ] control flow integrity

### Options

#### `target` ("node"/"browser")

Currently has no effect.

#### `randomizeOpcodes` (true/false)

Randomizes the opcode numbers.

#### `shuffleOpcodes` (true/false)

Shuffles the order of opcode handlers in the VM runtime.

#### `encodeBytecode` (true/false)

Encodes the bytecode array.

```js
// Before
var BYTECODE = [3, 0, 0, 1, 5, 0, 2, 12, 1, 14, 13];

// After
var BYTECODE = "AwAAAAAAAQAFAAAAAgAMAAEADgANAA==";
```

#### `macroOpcodes` (true/false)

Combines multiple opcodes commonly used from your bytecode.

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

#### `specializedOpcodes` (true/false)

Creates specialized opcodes for commonly used opcode+operand pairs.

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

#### `selfModifying` (true/false)

Function bodies are replaced upon runtime entry to the real bytecode.

```diff
// Input
function greet() {
  console.log("Hello, world!");
}

// Before
// [3, 1],      LOAD_GLOBAL  "console"                  2:2-2:9
// [0, 2],      LOAD_CONST  "log"                       2:2-2:30
// [5],         GET_PROP                                2:2-2:30
// [0, 3],      LOAD_CONST  "Hello, world!"             2:14-2:29
// [12, 1],     CALL_METHOD  (1 args)                   2:2-2:30
// [14],        POP                                     2:2-2:31
// [0, 4],      LOAD_CONST  undefined                   1:0-3:1
// [13],        RETURN                                  1:0-3:1

// After
// [56, 17, 30, 42], PATCH  [17, 30, 42]                     
-// [24],        STORE_UPVALUE      <-- 12 length of garbage code
-// [15],        LT                                      
-// [5],         GET_PROP                                
-// [46],        IN                                      
-// [57],        TRY_SETUP                               
-// [50],        DUP                                     
-// [55],        FOR_IN_NEXT                             
-// [41],        SHR                                     
-// [53],        LOOSE_NEQ                               
-// [7],         SUB                                     
-// [3],         LOAD_GLOBAL                             
-// [8],         MUL
// [13],        RETURN                                  1:0-3:1
+// [3, 1],      LOAD_GLOBAL  "console"      <-- 12 length of real code
+// [0, 2],      LOAD_CONST  "log"                       2:2-2:30
+// [5],         GET_PROP                                2:2-2:30
+// [0, 3],      LOAD_CONST  "Hello, world!"             2:14-2:29
+// [12, 1],     CALL_METHOD  (1 args)                   2:2-2:30
+// [14],        POP                                     2:2-2:31
+// [0, 4],      LOAD_CONST  undefined                   1:0-3:1
```

#### `timingChecks` (true/false)

Detects the use of debuggers by checking for >1second pauses. May break code with slow sync tasks.


#### `minify` (true/false)

Minifies the final code with Google Closure Compiler. Renames the VM class properties.

### No Try Finally

While Try Catch is supported, Try..Finally is not. You can use Try..Finally by defining an outside helper function:

```js
function TryFinally(cb, _finally) {
  try {
    return { value: cb() }
  } catch (error) {
    return { error };
  } finally {
    _finally()
  }
}
```

### ES5 Only

This VM Compiler only supports ES5 JavaScript. Most ES6+ features are syntax sugar that can be transpiled down relatively easily. This is a design decision to keep the VM wrapper simple and the bytecode more uniform. Having opcodes dedicated for classes and methods makes them standout more for attackers to debug easier. Keeping things simple enables easier hardening improvements.

Please transpile your code down first using [Babel](https://github.com/babel/babel).

### Project

- Stack based VM
- Lua-style closure and upvalue model
- CPython-style opcodes and codegen
- Compiler is in src/compiler.ts
- Runtime is in src/runtime.ts
- "Typescript"
- - This "Typescript" project uses Node's new flag `--experimental-strip-types`. This means we can run `node index.ts` directly!

### Best practices

- **Don't rely on "function.length"**
- Avoid undeclared variables
- Don't rely on "function.name"
- Don't use eval() to reference or modify local variables

### Use with JS-Confuser

JS-Confuser is recommended to be applied *after* virtualizing your source code. JS-Confuser's CFF can safeguard and obfuscate your VM internals - adding a layer of obscurity and preventing analysis of the opcodes. 

```js
import JsConfuser from "js-confuser";
import JsConfuserVM from "js-confuser-vm";
import { readFile, writeFile } from "fs/promises";

async function main() {
  // Read input code
  const sourceCode = await readFile("input.js", "utf8");

  const { code: virtualized } = await JsConfuserVM.obfuscate(sourceCode, {
    target: "browser",
    randomizeOpcodes: true
  });
  const { code: obfuscated } = await JsConfuser.obfuscate(virtualized, {
    target: "browser",
    preset: "medium",
    pack: false,
    globalConcealing: false,
  });

  // Write output file
  await writeFile("output.js", obfuscated, "utf8");
}

main().catch(console.error);
```

### WIP

- 178 tests, 91.18% coverage
- [Test262 (es5-tests)](https://github.com/tc39/test262/tree/es5-tests) percentage: 66.67%

### Made with AI

This project has been created with the help of AI. Expect issues.

### License

MIT License