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
  encodeBytecode: true, // encode the bytecode array?
  concealConstants: true, // conceal strings and integers in the constant pool?
  selfModifying: true, // do self-modifying bytecode for function bodies?
  macroOpcodes: true, // create combined opcodes for repeated instruction sequences?
  specializedOpcodes: true, // create specialized opcodes for commonly used opcode+operand pairs?
  aliasedOpcodes: true, // create duplicate opcodes for commonly used opcodes?
  timingChecks: true, // add timing checks to detect debuggers?
  minify: true // pass final output through Google Closure Compiler? (Renames VM class properties)
}).then(result => {
  console.log(result.code)
})

/*
var c=Symbol();function ha(b,k){this.A=b;this.H=k;this.I=!1;this.J=void 0}function ia(b){return b.I?b.J:b.A.g[b.H]}function ja(b,k){b.I?b.J=k:b.A.g[b.H]=k}function y(b){this.v=b;this.D=[];this.prototype={}}function B(b,k,a){this.K=b;this.g=Array(b.v.L).fill(void 0);this.i=b.v.P;this.V=k!==void 0?k:void 0;this.G=a!==void 0?a:0;this.m=null;this.F=[]}function C(b,k,a,g,t){this.o=b;this.l=g;this.u=t;this.j=[];this.B=[];this.h=new B(new y({C:0,L:a,P:k}),void 0,0)}function D(b){return b.o[b.h.i++]}
function ka(b,k,a){for(var g=0;g<b.B.length;g++){var t=b.B[g];if(t.A===k&&t.H===a)return t}t=new ha(k,a);b.B.push(t);return t}function R(b,k){b.B=b.B.filter(function(a){return a.A===k?(a.J=a.A.g[a.H],a.I=!0,!1):!0})}
function S(b){for(var k=performance.now();;){var a=b.h;if(a.i>=b.o.length)break;var g=b.o[a.i++],t=performance.now(),la=t-k>1E3;k=t;if(la){for(var e=0;e<b.o.length;e++)b.o[e]=0;a.g.fill(void 0);g=50848;a.i=b.o.length}try{switch(g){case 6517:var d=D(b),f=a.g[D(b)];a.g[d]=f===a.g[D(b)];break;case 50054:d=D(b);var p=a.g[D(b)],x=D(b),m=Array(x);for(e=0;e<x;e++)m[e]=a.g[D(b)];if(p&&p[c]){var v=p[c],r=new B(v,b.u,d);for(e=0;e<m.length;e++)r.g[e]=m[e];r.g[v.v.C]=m;b.j.push(b.h);b.h=r}else a.g[d]=p.apply(null,
m);break;case 5504:var l=a.g[D(b)],n=a.g[D(b)],ma=a.g[D(b)],z=Object.getOwnPropertyDescriptor(l,n);a={set:ma,configurable:!0,enumerable:!0};z&&typeof z.get==="function"&&(a.get=z.get);Object.defineProperty(l,n,a);break;case 36488:d=6;a.g[d]=b.l[1];break;case 29667:d=D(b);f=a.g[D(b)];a.g[d]=f|a.g[D(b)];break;case 29500:d=D(b);a.g[d]=+a.g[D(b)];break;case 16142:d=D(b);var V=a.g[D(b)];p=a.g[D(b)];x=D(b);m=Array(x);for(e=0;e<x;e++)m[e]=a.g[D(b)];if(p&&p[c]){v=p[c];r=new B(v,V,d);for(e=0;e<m.length;e++)r.g[e]=
m[e];r.g[v.v.C]=m;b.j.push(b.h);b.h=r}else a.g[d]=p.apply(V,m);break;case 2036:d=D(b);l=a.g[D(b)];n=a.g[D(b)];a.g[d]=l[n];break;case 50848:a.i=D(b);break;case 46964:d=3;a.g[d]=b.l[3];break;case 17567:d=D(b);f=a.g[D(b)];a.g[d]=f/a.g[D(b)];break;case 46176:var h=a.g[3];R(b,a);if(b.j.length===0)return h;a.m===null||typeof h==="object"&&h!==null||(h=a.m);var u=b.j.pop();u.g[a.G]=h;b.h=u;break;case 40235:d=D(b);f=a.g[D(b)];a.g[d]=f!=a.g[D(b)];break;case 2835:d=5;a.g[d]=b.l[0];break;case 53433:var na=D(b),
W=D(b),oa=D(b);for(a=W;a<oa;a++)b.o[na+(a-W)]=b.o[a];break;case 42352:l=a.g[D(b)];n=a.g[D(b)];var E=a.g[D(b)];Reflect.set(l,n,E);break;case 23743:d=4;a.g[d]=a.g[5];break;case 50800:d=1;a.g[d]=a.g[3];break;case 36349:throw a.g[D(b)];case 53101:d=4;a.g[d]=b.l[1];break;case 545:d=D(b);f=a.g[D(b)];a.g[d]=f>a.g[D(b)];break;case 55196:var pa=D(b);b.u[b.l[pa]]=a.g[D(b)];break;case 22757:var w=4,q=76;a.g[w]||(a.i=q);break;case 58785:d=3;a.g[d]=b.l[1];break;case 25598:d=D(b);a.g[d]=a.V;break;default:throw Error("Unknown opcode: "+
g+" at pc "+(a.i-1));case 53665:d=5;l=a.g[3];n=a.g[4];a.g[d]=l[n];break;case 9914:d=3;a.g[d]=a.g[4];break;case 14527:d=D(b);f=a.g[D(b)];a.g[d]=f^a.g[D(b)];break;case 4831:d=D(b);a.g[d]=-a.g[D(b)];break;case 41053:d=D(b);a.g[d]=typeof a.g[D(b)];break;case 23985:d=D(b);D(b);a.g[d]=void 0;break;case 9348:d=3;a.g[d]=b.u[b.l[4]];break;case 1904:a.F.push({T:D(b),R:D(b),S:b.j.length});break;case 14261:w=9;q=107;a.g[w]||(a.i=q);break;case 44576:d=D(b);l=a.g[D(b)];n=a.g[D(b)];a.g[d]=delete l[n];break;case 6789:w=
D(b);q=D(b);a.g[w]||(a.i=q);break;case 17207:w=D(b);q=D(b);a.g[w]&&(a.i=q);break;case 21753:d=D(b);var X=b.l[D(b)];E=Object.prototype.hasOwnProperty.call(b.u,X)?b.u[X]:void 0;a.g[d]=typeof E;break;case 9073:d=3;a.g[d]=a.g[6];break;case 26633:d=D(b);a.g[d]=b.l[D(b)];break;case 57348:d=D(b);f=a.g[D(b)];a.g[d]=f>=a.g[D(b)];break;case 43802:d=D(b);var Y=D(b),Z=Array(Y);for(e=0;e<Y;e++)Z[e]=a.g[D(b)];a.g[d]=Z;break;case 38611:d=4;a.g[d]=b.l[5];break;case 43097:d=5;a.g[d]=b.l[2];break;case 16365:d=D(b);
a.g[d]=b.u[b.l[D(b)]];break;case 63592:d=D(b);p=a.g[D(b)];x=D(b);m=Array(x);for(e=0;e<x;e++)m[e]=a.g[D(b)];if(p&&p[c]){v=p[c];var aa=Object.create(v.prototype||null);r=new B(v,aa,d);r.m=aa;for(e=0;e<m.length;e++)r.g[e]=m[e];r.g[v.v.C]=m;b.j.push(b.h);b.h=r}else a.g[d]=Reflect.construct(p,m);break;case 56057:d=3;a.g[d]=b.l[2];break;case 20064:d=3;a.g[d]=a.g[2];break;case 46958:d=D(b);f=a.g[D(b)];a.g[d]=f==a.g[D(b)];break;case 5066:d=D(b);f=a.g[D(b)];a.g[d]=f-a.g[D(b)];break;case 16426:h=a.g[4];R(b,
a);if(b.j.length===0)return h;a.m===null||typeof h==="object"&&h!==null||(h=a.m);u=b.j.pop();u.g[a.G]=h;b.h=u;break;case 47875:a.i=45;break;case 51418:d=2;a.g[d]=a.g[5];break;case 25520:d=D(b);f=a.g[D(b)];a.g[d]=f*a.g[D(b)];break;case 41854:d=D(b);l=a.g[D(b)];g=[];if(l!==null&&l!==void 0)for(var ba=Object.create(null),F=Object(l);F!==null;){var ca=Object.getOwnPropertyNames(F);for(e=0;e<ca.length;e++){var H=ca[e];if(!(H in ba)){ba[H]=!0;var da=Object.getOwnPropertyDescriptor(F,H);da&&da.enumerable&&
g.push(H)}}F=Object.getPrototypeOf(F)}a.g[d]={N:g,O:0};break;case 45737:d=D(b);var qa=D(b);g={};for(e=0;e<qa;e++)n=a.g[D(b)],E=a.g[D(b)],g[n]=E;a.g[d]=g;break;case 3520:d=D(b);f=a.g[D(b)];a.g[d]=f<<a.g[D(b)];break;case 34870:d=D(b);a.g[d]=!a.g[D(b)];break;case 11596:d=D(b);a.g[d]=~a.g[D(b)];break;case 16818:w=9;q=25;a.g[w]||(a.i=q);break;case 38378:d=D(b);a.g[d]=ia(a.K.D[D(b)]);break;case 50935:d=D(b);f=a.g[D(b)];a.g[d]=f>>>a.g[D(b)];break;case 7720:d=0;a.g[d]=a.g[7];break;case 61003:d=8;a.g[d]=b.l[1];
break;case 40007:d=D(b);f=a.g[D(b)];a.g[d]=f&a.g[D(b)];break;case 48619:debugger;break;case 21396:d=D(b);a.g[d]=a.g[D(b)];break;case 34467:d=D(b);a.g[d]=D(b);break;case 26361:h=a.g[D(b)];R(b,a);if(b.j.length===0)return h;a.m===null||typeof h==="object"&&h!==null||(h=a.m);u=b.j.pop();u.g[a.G]=h;b.h=u;break;case 7585:l=a.g[D(b)];n=a.g[D(b)];var ra=a.g[D(b)];z=Object.getOwnPropertyDescriptor(l,n);a={get:ra,configurable:!0,enumerable:!0};z&&typeof z.set==="function"&&(a.set=z.set);Object.defineProperty(l,
n,a);break;case 23121:var sa=D(b);ja(a.K.D[sa],a.g[D(b)]);break;case 51231:d=D(b);f=a.g[D(b)];a.g[d]=f%a.g[D(b)];break;case 22797:d=D(b);var I=a.g[D(b)],ta=D(b);I.O>=I.N.length?a.i=ta:a.g[d]=I.N[I.O++];break;case 37593:a.i=9;break;case 504:d=D(b);f=a.g[D(b)];a.g[d]=f>>a.g[D(b)];break;case 5174:h=a.g[5];R(b,a);if(b.j.length===0)return h;a.m===null||typeof h==="object"&&h!==null||(h=a.m);u=b.j.pop();u.g[a.G]=h;b.h=u;break;case 9939:d=5;a.g[d]=a.g[0];break;case 41972:d=5;f=a.g[2];a.g[d]=f+a.g[4];break;
case 49424:d=7;f=a.g[0];a.g[d]=f-a.g[6];break;case 26807:d=D(b);f=a.g[D(b)];a.g[d]=f<a.g[D(b)];break;case 21843:d=4;a.g[d]=a.g[0];break;case 19103:d=D(b);f=a.g[D(b)];a.g[d]=f in a.g[D(b)];break;case 40335:d=D(b);l=a.g[D(b)];var M=a.g[D(b)];if(typeof M==="function")a.g[d]=l instanceof M;else{var ua=M.prototype;q=Object.getPrototypeOf(l);for(g=!1;q!==null;){if(q===ua){g=!0;break}q=Object.getPrototypeOf(q)}a.g[d]=g}break;case 47743:d=D(b);f=a.g[D(b)];a.g[d]=f+a.g[D(b)];break;case 27740:d=4;f=a.g[2];
a.g[d]=f<=a.g[3];break;case 51318:d=D(b);f=a.g[D(b)];a.g[d]=f!==a.g[D(b)];break;case 64752:d=2;a.g[d]=a.g[3];break;case 1927:a.i=91;break;case 22484:d=5;f=a.g[2];a.g[d]=f+a.g[3];break;case 64028:d=D(b);var va=D(b),wa=D(b),xa=D(b),ea=D(b),J=Array(ea);for(e=0;e<ea;e++){var ya=D(b),za=D(b);J[e]={U:ya,M:za}}var G=new y({C:wa,L:xa,P:va,W:J});for(e=0;e<J.length;e++){var N=J[e];N.U?G.D.push(ka(b,a,N.M)):G.D.push(a.K.D[N.M])}var K=b,Q=function(A){return function(){for(var O=Array.prototype.slice.call(arguments),
fa=new C(K.o,0,A.v.L,K.l,K.u),P=new B(A,this==null?K.u:this,0),L=0;L<O.length;L++)P.g[L]=O[L];P.g[A.v.C]=O;fa.h=P;return S(fa)}}(G);Q[c]=G;Q.prototype=G.prototype;a.g[d]=Q;break;case 30313:d=9;f=a.g[5];a.g[d]=f>a.g[8];break;case 50428:a.F.pop();break;case 35999:d=D(b),f=a.g[D(b)],a.g[d]=f<=a.g[D(b)]}}catch(A){a=null;for(g=b.h;;){if(g.F.length>0){a=g;break}R(b,g);if(b.j.length===0)break;g=b.j.pop();b.h=g}if(!a)throw A;g=a.F.pop();b.j.length=g.S;a.g[g.R]=A;a.i=g.T;b.h=a}}}var T={},U;
for(U of Object.getOwnPropertyNames(globalThis))T[U]=globalThis[U];typeof window!=="undefined"&&(T.window=window);T.undefined=void 0;T.Infinity=Infinity;T.NaN=NaN;
S(new C(function(b){b=typeof Buffer!=="undefined"?Buffer.from(b,"base64"):Uint8Array.from(atob(b),function(g){return g.charCodeAt(0)});for(var k=new Uint16Array(b.length/2),a=0;a<k.length;a++)k[a]=b[a*2]|b[a*2+1]<<8;return k}("udAEAHIAdwAOP263K53rveu9udANAHcAgwCUUyud6pWUUx/IHPo3Q/2Nj50hArdobre50B0AgwCGAMoT+WYc+rnQJACGAI8AIQJo+Dxzo4afRO0/98YhAqDGudAxAI8AoQCwY7FdoR0NWX+6PHNRWuu9f7qUU7dot2ifRJ+MBOCAFYAVt2i50EcAoQCmAJ+M/Y1ut3ClDVm50FAApgCoAF2gHPq50FYAqACtAONzoMbfEvQHqbK50F8ArQC5AONzNoj4AXAH43P3xpRT/MSc14bDdsjADbnQbwC5ALwAPHM3Q+0/EwvayIiOcSNTVdMmiI4QwSgeS+5pdrJB1Fe/XPD8uibZkipAWag2FBz6AwBSAAEACgAAAHDGoeXw/HS3XGzlWIQk05ah0YbDBgABAAEAAgAOPwcAAwAFAAIAAgAGAGBObc/0o9rIA7v52mC0EwvayIiOcSNTVdMmiI4QwSgeS+5pdrU31Fe/XPD8uiaHBypAWag2FA=="),32,
0,[0,1,void 0,25,"console","log"],T));
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
- [x] aliased opcodes (create duplicate opcodes, including variants with shuffled operand order)
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
var BYTECODE = [2, 1, 0, 0, 2, 1, 8, 3, 1, 2, 0, 4, 2, 43, 5, 1, 3, 1, 4, 0, 1, 3, 45, 1];

// After
var BYTECODE = "AgABAAAAAAACAAEACAADAAEAAgAAAAQAAgArAAUAAQADAAEABAAAAAEAAwAtAAEA";
```

#### `concealConstants` (true/false)

Conceals strings and integers in the constant pool.

```js
// Before
var CONSTANTS = [/* 0 */"console", /* 1 */"log", /* 2 */"Hello world!", /* 3 */undefined];

// After
var CONSTANTS = [/* 0 */"DaQApB6kAqQdpB+kEaQ=", /* 1 */"TCFOIUUh", /* 2 */"kKK8orait6Kzov2iqaKwopKijaKGosKi", /* 3 */undefined];
```

#### `macroOpcodes` (true/false)

Combines multiple opcodes commonly used from your bytecode.

```js
// Input Code
console.log("Hello world!");
console.log("Hello world!");

// Before
// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console                     2:0-2:7
// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        2:0-2:27
// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               2:0-2:27
// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello world!"               2:12-2:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)2:0-2:27
// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console                     3:0-3:7
// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        3:0-3:27
// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               3:0-3:27
// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello world!"               3:12-3:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)3:0-3:27

// After
// [5074, 1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4], LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST,CALL_METHOD  [1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4]2:0-2:7
// [5074, 1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4], LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST,CALL_METHOD  [1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4]3:0-3:7

// What the opcode "LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST,CALL_METHOD" (5074) looks like:
case 5074:
  // LOAD_GLOBAL
  var dst = this._operand();
  frame.regs[dst] = this.globals[this.constants[this._operand()]];
  // LOAD_CONST
  var dst = this._operand();
  frame.regs[dst] = this.constants[this._operand()];
  // GET_PROP
  // dst = regs[obj][regs[key]]
  var dst = this._operand();
  var obj = frame.regs[this._operand()];
  var key = frame.regs[this._operand()];
  frame.regs[dst] = obj[key];
  // LOAD_CONST
  var dst = this._operand();
  frame.regs[dst] = this.constants[this._operand()];
  // CALL_METHOD
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
```

#### `specializedOpcodes` (true/false)

Creates specialized opcodes for commonly used opcode+operand pairs.

```js
// Input Code
console.log("Hello world!");

// Before
// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console                     1:0-1:7
// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        1:0-1:27
// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               1:0-1:27
// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello world!"               1:12-1:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)1:0-1:27

// What the opcode "LOAD_GLOBAL" looks like:
case OP.LOAD_CONST:
  var dst = this._operand();
  frame.regs[dst] = this.constants[this._operand()];
  break;

// After
// [16316],             LOAD_GLOBAL_1_0                                   1:0-1:7
// [43765],             LOAD_CONST_2_1                                    1:0-1:27
// [58568],             GET_PROP_3_1_2                                    1:0-1:27
// [35110],             LOAD_CONST_4_2                                    1:12-1:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)1:0-1:27

// What the opcode "LOAD_GLOBAL_1_0" (16316) looks like:
case 16316:
  // LOAD_GLOBAL_1_0 (specialized)
  var dst = 1;
  frame.regs[dst] = this.globals[this.constants[0]];
  break;
```

#### `aliasedOpcodes` (true/false)

Creates duplicate opcodes, including variants with shuffled operand order.

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

#### `selfModifying` (true/false)

Function bodies are replaced upon runtime entry to the real bytecode.

```diff
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

// After
// [56, 4, 28, 50],     PATCH  [4, 28, 50]                                
-// [52],                FOR_IN_SETUP      <-- 22 ints of garbage code
-// [39],                JUMP                                              
-// [12],                SUB                                               
-// [12],                SUB                                               
-// [2],                 LOAD_GLOBAL                                       
-// [28],                LOOSE_EQ                                          
-// [12],                SUB                                               
-// [46],                THROW                                             
-// [18],                BXOR                                              
-// [8],                 GET_PROP                                          
-// [5],                 MOVE                                              
-// [55],                TRY_END                                           
-// [57],                DEBUGGER                                          
-// [46],                THROW                                             
-// [23],                GT                                                
-// [48],                BUILD_ARRAY                                       
-// [28],                LOOSE_EQ                                          
-// [18],                BXOR                                              
-// [2],                 LOAD_GLOBAL                                       
-// [50],                DEFINE_GETTER                                     
-// [4],                 LOAD_THIS                                         
-// [24],                LTE                                               
// [45, 1],             RETURN  reg[1]                                    
+// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console      <-- 22 ints of real code 
+// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        1:0-1:28
+// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               1:0-1:28
+// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello, world!"              1:12-1:27
+// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)1:0-1:28
+// [0, 1, 3],           LOAD_CONST  reg[1] = undefined                    
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

- Register base VM
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