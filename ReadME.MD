# JS Confuser VM

**Requires Node v24.13.1 or higher**

- ES5 support only. No complex features: async, generator, and even try..catch are beyond scope.
- Experimental. Expect issues.

### Usage

```shell
$ git clone https://github.com/MichaelXF/js-confuser-vm
```

- Example Script:

```js
import { virtualize } from "./src/index.js";
import { readFileSync, writeFileSync } from "fs";

const sourceCode = readFileSync("input.js", "utf-8");
const { code: output } = virtualize(sourceCode);

writeFileSync("output.js", output, "utf-8");
console.log(output);
```

- Input/Output:

```js
function fibonacci(num) {
  var a = 0,
    b = 1,
    c = num;
  while (num-- > 1) {
    c = a + b;
    a = b;
    b = c;
  }
  return c;
}

for (var i = 1; i <= 25; i++) {
  console.log(i, fibonacci(i));
}

/*
function d(a){a=typeof Buffer!=="undefined"?Buffer.from(a,"base64"):Uint8Array.from(atob(a),function(b){return b.charCodeAt(0)});for(var h=new Int32Array(a.length/4),c=0;c<h.length;c++)h[c]=a[c*4]|a[c*4+1]<<8|a[c*4+2]<<16|a[c*4+3]<<24;return h}var f=Symbol();function l(a,h){this.g=a;this.m=h;this.n=!1;this.p=void 0}function m(a){return a.n?a.p:a.g.b[a.m]}function n(a,h){a.n?a.p=h:a.g.b[a.m]=h}function p(a){this.f=a;this.l=[];this.prototype={}}
function w(a,h){this.r=a;this.b=Array(a.f.t).fill(void 0);this.d=a.f.u;this.x=h!==void 0?h:void 0;this.o=null}function x(a,h,c){this.q=a;this.e=h;this.i=c;this.a=[];this.h=[];this.j=[];this.c=new w(new p({k:0,t:0,u:0}))}function y(a,h){a.a.push(h)}function z(a){return a.a.pop()}function A(a){return a.a[a.a.length-1]}function E(a,h,c){for(var b=0;b<a.j.length;b++){var e=a.j[b];if(e.g===h&&e.m===c)return e}e=new l(h,c);a.j.push(e);return e}
function F(a,h){a.j=a.j.filter(function(c){return c.g===h?(c.p=c.g.b[c.m],c.n=!0,!1):!0})}
function G(a){for(var h=performance.now();;){var c=a.c,b=a.q;if(c.d>=b.length)break;b=b[c.d++];var e=b&255;b>>>=8;var g=performance.now(),k=g-h>1E3;h=g;k&&(e=13);switch(e){case 0:y(a,a.e[b]);break;case 1:y(a,c.b[b]);break;case 2:c.b[b]=z(a);break;case 3:y(a,a.i[a.e[b]]);break;case 4:a.i[a.e[b]]=z(a);break;case 5:c=z(a);b=A(a);y(a,b[c]);break;case 6:b=z(a);y(a,z(a)+b);break;case 7:b=z(a);y(a,z(a)-b);break;case 8:b=z(a);y(a,z(a)*b);break;case 9:b=z(a);y(a,z(a)/b);break;case 36:b=z(a);y(a,z(a)%b);break;
case 37:b=z(a);y(a,z(a)&b);break;case 38:b=z(a);y(a,z(a)|b);break;case 39:b=z(a);y(a,z(a)^b);break;case 40:b=z(a);y(a,z(a)<<b);break;case 41:b=z(a);y(a,z(a)>>b);break;case 42:b=z(a);y(a,z(a)>>>b);break;case 15:b=z(a);y(a,z(a)<b);break;case 16:b=z(a);y(a,z(a)>b);break;case 17:b=z(a);y(a,z(a)===b);break;case 20:b=z(a);y(a,z(a)<=b);break;case 21:b=z(a);y(a,z(a)>=b);break;case 22:b=z(a);y(a,z(a)!==b);break;case 52:b=z(a);y(a,z(a)==b);break;case 53:b=z(a);y(a,z(a)!=b);break;case 46:b=z(a);y(a,z(a)in b);
break;case 47:c=z(a);b=z(a);if(typeof c==="function")y(a,b instanceof c);else{c=c.prototype;b=Object.getPrototypeOf(b);for(e=!1;b!==null;){if(b===c){e=!0;break}b=Object.getPrototypeOf(b)}y(a,e)}break;case 25:y(a,-z(a));break;case 26:y(a,z(a));break;case 27:y(a,!z(a));break;case 28:y(a,~z(a));break;case 29:y(a,typeof z(a));break;case 30:z(a);y(a);break;case 31:b=z(a);e=Object.prototype.hasOwnProperty.call(a.i,b)?a.i[b]:void 0;y(a,typeof e);break;case 18:c.d=b;break;case 19:z(a)||(c.d=b);break;case 44:A(a)?
c.d=b:z(a);break;case 43:A(a)?z(a):c.d=b;break;case 10:g=a.e[b];e=new p(g);for(b=0;b<g.v.length;b++)k=g.v[b],k.y?e.l.push(E(a,c,k.w)):e.l.push(c.r.l[k.w]);var t=a;b=function(B){return function(){for(var u=Array.prototype.slice.call(arguments),C=new x(t.q,t.e,t.i),v=new w(B,this),q=0;q<u.length;q++)v.b[q]=u[q];v.b[B.f.k]=u;C.c=v;return G(C)}}(e);b[f]=e;b.prototype=e.prototype;y(a,b);break;case 23:y(a,m(c.r.l[b]));break;case 24:n(c.r.l[b],z(a));break;case 32:b=a.a.splice(a.a.length-b);y(a,b);break;
case 33:c=a.a.splice(a.a.length-b*2);e={};for(b=0;b<c.length;b+=2)e[c[b]]=c[b+1];y(a,e);break;case 34:e=z(a);c=z(a);b=z(a);b[c]=e;y(a,e);break;case 35:c=z(a);b=z(a);y(a,b[c]);break;case 45:c=z(a);b=z(a);y(a,delete b[c]);break;case 11:c=a.a.splice(a.a.length-b);if((e=z(a))&&e[f]){e=e[f];g=new w(e);for(b=0;b<c.length;b++)g.b[b]=c[b];g.b[e.f.k]=c;a.h.push(a.c);a.c=g}else y(a,e.apply(null,c));break;case 12:c=a.a.splice(a.a.length-b);e=z(a);b=z(a);if(e&&e[f]){e=e[f];g=new w(e,b);for(b=0;b<c.length;b++)g.b[b]=
c[b];g.b[e.f.k]=c;a.h.push(a.c);a.c=g}else y(a,e.apply(b,c));break;case 48:y(a,c.x);break;case 49:c=a.a.splice(a.a.length-b);if((e=z(a))&&e[f]){e=e[f];b=Object.create(e.prototype||null);g=new w(e,b);g.o=b;for(b=0;b<c.length;b++)g.b[b]=c[b];g.b[e.f.k]=c;a.h.push(a.c);a.c=g}else y(a,Reflect.construct(e,c));break;case 13:b=z(a);F(a,c);if(a.h.length===0)return b;c.o===null||typeof b==="object"&&b!==null||(b=c.o);a.c=a.h.pop();y(a,b);break;case 14:z(a);break;case 50:y(a,A(a));break;case 51:throw z(a);
case 54:b=z(a);c=[];if(b!==null&&b!==void 0)for(e=Object.create(null),g=Object(b);g!==null;){k=Object.getOwnPropertyNames(g);for(b=0;b<k.length;b++){var r=k[b];if(!(r in e)){e[r]=!0;var D=Object.getOwnPropertyDescriptor(g,r);D&&D.enumerable&&c.push(r)}}g=Object.getPrototypeOf(g)}y(a,{keys:c,s:0});break;case 55:e=z(a);e.s>=e.keys.length?c.d=b:y(a,e.keys[e.s++]);break;case 56:c=z(a);e=a.e[b];e=d(e);for(b=0;b<e.length;b++)a.q[c+b]=e[b];break;default:throw Error("Unknown opcode: "+e+" at pc "+(c.d-1));
}}}var H={},I;for(I of Object.getOwnPropertyNames(globalThis))H[I]=globalThis[I];typeof window!=="undefined"&&(H.window=window);H.undefined=void 0;H.Infinity=Infinity;H.NaN=NaN;
G(new x(d("CgMAAAQEAAAAAQAABAUAAAMFAAAABgAAFAAAABMYAAADBwAAAAgAAAUAAAADBQAAAwQAAAMFAAALAQAADAIAAA4AAAADBQAAMgAAAAABAAAGAAAABAUAAA4AAAASBAAADQAAAAAKAAA4CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="),[0,1,void 0,{k:1,t:5,v:[],u:25},"fibonacci","i",25,"console","log","AAAAAAICAAAAAQAAAgMAAAEAAAACBAAAAQAAADIAAAAAAQAABwAAAAIAAAAAAQAAEAAAABM4AAABAgAAAQMAAAYAAAACBAAAAQQAAA4AAAABAwAAAgIAAAECAAAOAAAAAQQAAAIDAAABAwAADgAAABIhAAABBAAADQAAAAACAAANAAAADQAAAA==",
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

### Missing

- [ ] try..catch
- [ ] RegExp literals
- [ ] with statement
- [ ] arguments.callee, argument parameter syncing   
- [ ] getter/setters

### Hardening

- [x] opcode randomization per build
- [x] property name concealment of vm internals
- - Google Closure Compiler aggressively renames our class props
- [ ] shuffled handler order
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

`minify.js` uses Google Closure Compiler to minify the JS VM and renames (most) VM property names. This approach helps keep the VM Compiler simple and lets Google do the heavy lifting.

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

### WIP

- 120 tests, 90.16% coverage
- [Test262 (es5-tests)](https://github.com/tc39/test262/tree/es5-tests) percentage: 43.26%

### Made with AI

This project has been created with the help of AI. Expect issues.

### License

MIT License