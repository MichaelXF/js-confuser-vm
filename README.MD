# JS Confuser VM

  [![NPM](https://img.shields.io/badge/NPM-%23000000.svg?style=for-the-badge&logo=npm&logoColor=white)](https://npmjs.com/package/js-confuser-vm) [![GitHub](https://img.shields.io/badge/github-%23121011.svg?style=for-the-badge&logo=github&logoColor=white)](https://github.com/MichaelXF/js-confuser-vm)


- **Requires Node v24.13.1 or higher**
- ES5 support only. No complex features: async, generator, and even try..catch are beyond scope.
- Experimental. Expect issues.

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
  randomizeOpcodes: true, // randomize opcode values in OP mapping?
  shuffleOpcodes: true, // shuffle order of opcode handlers in the runtime?
  encodeBytecode: true, // encode bytecode? when off, comments for instructions are added
  selfModifying: true, // do self-modifying bytecode for function bodies?
  timingChecks: true, // add timing checks to detect debuggers?
  minify: true // pass final output through Google Closure Compiler? (Renames VM class properties)
}).then(result => {
  console.log(result.code)
})

/*
function d(a){a=typeof Buffer!=="undefined"?Buffer.from(a,"base64"):Uint8Array.from(atob(a),function(b){return b.charCodeAt(0)});for(var h=new Int32Array(a.length/4),c=0;c<h.length;c++)h[c]=a[c*4]|a[c*4+1]<<8|a[c*4+2]<<16|a[c*4+3]<<24;return h}var f=Symbol();function l(a,h){this.g=a;this.m=h;this.n=!1;this.p=void 0}function m(a){return a.n?a.p:a.g.b[a.m]}function n(a,h){a.n?a.p=h:a.g.b[a.m]=h}function p(a){this.f=a;this.l=[];this.prototype={}}
function w(a,h){this.r=a;this.b=Array(a.f.t).fill(void 0);this.d=a.f.u;this.x=h!==void 0?h:void 0;this.o=null}function x(a,h,c){this.q=a;this.e=h;this.i=c;this.a=[];this.h=[];this.j=[];this.c=new w(new p({k:0,t:0,u:0}))}function y(a,h){a.a.push(h)}function z(a){return a.a.pop()}function A(a){return a.a[a.a.length-1]}function E(a,h,c){for(var b=0;b<a.j.length;b++){var e=a.j[b];if(e.g===h&&e.m===c)return e}e=new l(h,c);a.j.push(e);return e}
function F(a,h){a.j=a.j.filter(function(c){return c.g===h?(c.p=c.g.b[c.m],c.n=!0,!1):!0})}
function G(a){for(var h=performance.now();;){var c=a.c,b=a.q;if(c.d>=b.length)break;b=b[c.d++];var e=b&255;b>>>=8;var g=performance.now(),k=g-h>1E3;h=g;k&&(e=149);switch(e){case 142:b=z(a);y(a,z(a)in b);break;case 109:b=z(a);c=[];if(b!==null&&b!==void 0)for(e=Object.create(null),g=Object(b);g!==null;){k=Object.getOwnPropertyNames(g);for(b=0;b<k.length;b++){var q=k[b];if(!(q in e)){e[q]=!0;var B=Object.getOwnPropertyDescriptor(g,q);B&&B.enumerable&&c.push(q)}}g=Object.getPrototypeOf(g)}y(a,{keys:c,
s:0});break;default:throw Error("Unknown opcode: "+e+" at pc "+(c.d-1));case 243:z(a);y(a);break;case 114:b=z(a);y(a,z(a)^b);break;case 81:y(a,m(c.r.l[b]));break;case 6:A(a)?c.d=b:z(a);break;case 158:c=a.a.splice(a.a.length-b);e=z(a);b=z(a);if(e&&e[f]){e=e[f];g=new w(e,b);for(b=0;b<c.length;b++)g.b[b]=c[b];g.b[e.f.k]=c;a.h.push(a.c);a.c=g}else y(a,e.apply(b,c));break;case 77:y(a,!z(a));break;case 161:y(a,a.i[a.e[b]]);break;case 231:b=z(a);y(a,z(a)-b);break;case 35:y(a,a.e[b]);break;case 168:b=z(a);
y(a,z(a)>b);break;case 224:g=a.e[b];e=new p(g);for(b=0;b<g.v.length;b++)k=g.v[b],k.y?e.l.push(E(a,c,k.w)):e.l.push(c.r.l[k.w]);var t=a;b=function(C){return function(){for(var u=Array.prototype.slice.call(arguments),D=new x(t.q,t.e,t.i),v=new w(C,this),r=0;r<u.length;r++)v.b[r]=u[r];v.b[C.f.k]=u;D.c=v;return G(D)}}(e);b[f]=e;b.prototype=e.prototype;y(a,b);break;case 49:c=z(a);b=z(a);if(typeof c==="function")y(a,b instanceof c);else{c=c.prototype;b=Object.getPrototypeOf(b);for(e=!1;b!==null;){if(b===
c){e=!0;break}b=Object.getPrototypeOf(b)}y(a,e)}break;case 115:b=z(a);y(a,z(a)|b);break;case 82:c=z(a);b=z(a);y(a,delete b[c]);break;case 60:n(c.r.l[b],z(a));break;case 182:y(a,z(a));break;case 177:c=a.a.splice(a.a.length-b);if((e=z(a))&&e[f]){e=e[f];b=Object.create(e.prototype||null);g=new w(e,b);g.o=b;for(b=0;b<c.length;b++)g.b[b]=c[b];g.b[e.f.k]=c;a.h.push(a.c);a.c=g}else y(a,Reflect.construct(e,c));break;case 72:y(a,c.x);break;case 53:b=z(a);y(a,z(a)===b);break;case 25:b=z(a);y(a,z(a)<=b);break;
case 75:c=z(a);b=A(a);y(a,b[c]);break;case 225:e=z(a);e.s>=e.keys.length?c.d=b:y(a,e.keys[e.s++]);break;case 181:b=z(a);y(a,z(a)%b);break;case 42:c.d=b;break;case 134:e=z(a);c=z(a);b=z(a);b[c]=e;y(a,e);break;case 67:b=z(a);y(a,z(a)*b);break;case 43:b=z(a);y(a,z(a)<b);break;case 52:c.b[b]=z(a);break;case 68:z(a);break;case 143:c=z(a);e=a.e[b];e=d(e);for(b=0;b<e.length;b++)a.q[c+b]=e[b];break;case 244:y(a,~z(a));break;case 23:c=a.a.splice(a.a.length-b);if((e=z(a))&&e[f]){e=e[f];g=new w(e);for(b=0;b<
c.length;b++)g.b[b]=c[b];g.b[e.f.k]=c;a.h.push(a.c);a.c=g}else y(a,e.apply(null,c));break;case 123:b=z(a);y(a,z(a)!=b);break;case 14:b=z(a);y(a,z(a)<<b);break;case 238:A(a)?z(a):c.d=b;break;case 180:c=a.a.splice(a.a.length-b*2);e={};for(b=0;b<c.length;b+=2)e[c[b]]=c[b+1];y(a,e);break;case 4:b=z(a);y(a,z(a)>>>b);break;case 19:b=z(a);y(a,z(a)&b);break;case 211:c=z(a);b=z(a);y(a,b[c]);break;case 97:b=z(a);y(a,z(a)!==b);break;case 255:b=z(a);y(a,z(a)==b);break;case 101:b=z(a);y(a,z(a)+b);break;case 122:throw z(a);
case 157:y(a,-z(a));break;case 149:b=z(a);F(a,c);if(a.h.length===0)return b;c.o===null||typeof b==="object"&&b!==null||(b=c.o);a.c=a.h.pop();y(a,b);break;case 34:y(a,A(a));break;case 213:a.i[a.e[b]]=z(a);break;case 173:z(a)||(c.d=b);break;case 216:y(a,typeof z(a));break;case 39:b=z(a);y(a,z(a)>>b);break;case 210:y(a,c.b[b]);break;case 190:b=z(a);y(a,z(a)/b);break;case 150:b=z(a);y(a,z(a)>=b);break;case 172:b=z(a);e=Object.prototype.hasOwnProperty.call(a.i,b)?a.i[b]:void 0;y(a,typeof e);break;case 113:b=
a.a.splice(a.a.length-b),y(a,b)}}}var H={},I;for(I of Object.getOwnPropertyNames(globalThis))H[I]=globalThis[I];typeof window!=="undefined"&&(H.window=window);H.undefined=void 0;H.Infinity=Infinity;H.NaN=NaN;
G(new x(d("4AMAANUEAAAjAQAA1QUAAKEFAAAjBgAAGQAAAK0YAAChBwAAIwgAAEsAAAChBQAAoQQAAKEFAAAXAQAAngIAAEQAAAChBQAAIgAAACMBAABlAAAA1QUAAEQAAAAqBAAAlQAAACMKAACPCQAARPEAAOcLAACeRQAA54YAALZ9AAA8jAAAbdUAALFkAAArdAAAcysAAI+3AACxbwAAqMAAABPbAACO1wAA88sAAJ3DAACeGgAAsVIAAOCMAACOVwAA85sAANIEAABRwAAAUSIAANicAADVgAAAj1UAANjtAAC1DAAArJMAADy0AAAnBwAAregAAA=="),[0,1,void 0,{k:1,t:5,v:[],u:25},"fibonacci","i",25,"console","log","IwAAADQCAAAjAQAANAMAANIAAAA0BAAA0gAAACIAAAAjAQAA5wAAADQAAAAjAQAAqAAAAK04AADSAgAA0gMAAGUAAAA0BAAA0gQAAEQAAADSAwAANAIAANICAABEAAAA0gQAADQDAADSAwAARAAAACohAADSBAAAlQAAACMCAACVAAAAlQAAAA==",
27],H));
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

### Missing

- [ ] try..catch
- [ ] with statement
- [ ] arguments.callee, argument parameter syncing   
- [ ] getter/setters

### Hardening

- [x] opcode randomization per build
- [x] property name concealment of vm internals
- - Google Closure Compiler aggressively renames our class props
- [x] shuffled handler order
- [ ] dead handlers
- [ ] dead bytecode insertion
- [ ] macro opcodes
- [x] encoded bytecode array and words
- [x] self-modifying bytecode
- [x] timing checks
- [ ] low-level bytecode obfuscations
- [ ] stack protection
- [ ] control flow integrity

### Minification

The `minify` option uses Google Closure Compiler to minify the JS VM and renames (most) VM property names. This approach helps keep the VM Compiler simple and lets Google do the heavy lifting.

### No Try Catch

Try..Catch is complex operator that may not get added. You can use Try..Catch by defining an outside helper function:

```js
function TryCatch(cb) {
  try {
    return { value: cb() };
  } catch (error) {
    return { error };
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

- 146 tests, 91.18% coverage
- [Test262 (es5-tests)](https://github.com/tc39/test262/tree/es5-tests) percentage: 52.39%

### Made with AI

This project has been created with the help of AI. Expect issues.

### License

MIT License