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
  dispatcher: true, // create middleman blocks to process jumps?
  selfModifying: true, // do self-modifying bytecode for function bodies?
  macroOpcodes: true, // create combined opcodes for repeated instruction sequences?
  microOpcodes: true, // break opcodes into sub-opcodes?
  specializedOpcodes: true, // create specialized opcodes for commonly used opcode+operand pairs?
  aliasedOpcodes: true, // create duplicate opcodes for commonly used opcodes?
  timingChecks: true, // add timing checks to detect debuggers?
  minify: true // pass final output through Google Closure Compiler? (Renames VM class properties)
}).then(result => {
  console.log(result.code)
})

/*
var c=Symbol();function f(a,e){this.A=a;this.H=e;this.I=!1;this.J=void 0}function h(a){return a.I?a.J:a.A.h[a.H]}function k(a,e){a.I?a.J=e:a.A.h[a.H]=e}function m(a){this.v=a;this.D=[];this.prototype={}}function n(a,e,b){this.K=a;this.h=Array(a.v.L).fill(void 0);this.l=a.v.R;this.W=e!==void 0?e:void 0;this.G=b!==void 0?b:0;this.o=null;this.F=[]}function p(a,e,b,d){this.u=a;this.O=b;this.m=d;this.j=[];this.B=[];this.i=new n(new m({C:0,L:e,R:0}),void 0,0);this.g={}}
function v(a){return a.u[a.i.l++]}function w(a,e,b){for(var d=0;d<a.B.length;d++){var g=a.B[d];if(g.A===e&&g.H===b)return g}g=new f(e,b);a.B.push(g);return g}function x(a,e,b){e=e??v(a);b=b??v(a);a=a.O[e];if(!b)return a;if(typeof a==="number")return a^b;a=typeof Buffer!=="undefined"?Buffer.from(a,"base64"):Uint8Array.from(atob(a),function(g){return g.charCodeAt(0)});e="";for(var d=0;d<a.length/2;d++)e+=String.fromCharCode((a[d*2]|a[d*2+1]<<8)^b+d&65535);return e}
function z(a,e){a.B=a.B.filter(function(b){return b.A===e?(b.J=b.A.h[b.H],b.I=!0,!1):!0})}
function A(a){for(var e=performance.now();;){var b=a.i;if(b.l>=a.u.length)break;var d=b.l++;d=a.u[d];var g=performance.now(),D=g-e>1E3;e=g;if(D){for(d=0;d<a.u.length;d++)a.u[d]=0;b.h.fill(void 0);d=51142;b.l=a.u.length}try{switch(d){case 48376:a.g[16541]=v(a);a.g[36877]=b.h[v(a)];b.h[a.g[16541]]=a.g[36877]^b.h[v(a)];break;case 24807:a.g[32755]=v(a);a.g[30211]=b.h[v(a)];b.h[a.g[32755]]=a.g[30211]>>>b.h[v(a)];break;case 25812:a.g[11979]=3;b.h[a.g[11979]]=b.h[4];break;case 21199:a.g[16541]=4;b.h[a.g[16541]]=
x(a,0,19941);break;case 48511:a.g[38915]=b.h[5];z(a,b);if(a.j.length===0)return a.g[38915];b.o===null||typeof a.g[38915]==="object"&&a.g[38915]!==null||(a.g[38915]=b.o);a.g[25255]=a.j.pop();a.g[25255].h[b.G]=a.g[38915];a.i=a.g[25255];break;case 26119:a.g[16541]=v(a);a.g[3839]=b.h[v(a)];b.h[a.g[16541]]=a.g[3839]>b.h[v(a)];break;case 7802:a.g[16541]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[16541]]=a.g[62634]!==b.h[v(a)];break;case 29164:a.g[16541]=3;b.h[a.g[16541]]=x(a,0,19941);break;case 45474:a.g[19089]=
v(a);a.g[25428]=b.h[v(a)];a.g[7422]=b.h[v(a)];a.g[40522]=v(a);a.g[28705]=Array(a.g[40522]);for(a.g[12462]=0;a.g[12462]<a.g[40522];a.g[12462]++)a.g[28705][a.g[12462]]=b.h[v(a)];if(a.g[7422]&&a.g[7422][c]){a.g[7358]=a.g[7422][c];a.g[58907]=new n(a.g[7358],a.g[25428],a.g[19089]);for(a.g[12462]=0;a.g[12462]<a.g[28705].length;a.g[12462]++)a.g[58907].h[a.g[12462]]=a.g[28705][a.g[12462]];a.g[58907].h[a.g[7358].v.C]=a.g[28705];a.j.push(a.i);a.i=a.g[58907]}else b.h[a.g[19089]]=a.g[7422].apply(a.g[25428],a.g[28705]);
break;case 47786:a.g[3766]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[3766]]=a.g[62634]!=b.h[v(a)];break;case 45528:a.g[16541]=2;b.h[a.g[16541]]=b.h[5];break;case 37324:a.g[38915]=b.h[v(a)];z(a,b);if(a.j.length===0)return a.g[38915];b.o===null||typeof a.g[38915]==="object"&&a.g[38915]!==null||(a.g[38915]=b.o);a.g[23776]=a.j.pop();a.g[23776].h[b.G]=a.g[38915];a.i=a.g[23776];break;case 37593:a.g[21276]=0;b.h[a.g[21276]]=b.h[7];break;case 16492:a.g[16541]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[16541]]=a.g[62634]<=
b.h[v(a)];break;case 1900:b.l=13;break;case 42013:a.m[x(a)]=b.h[v(a)];break;case 63795:a.g[28560]=v(a);b.h[a.g[28560]]=v(a);break;case 54788:a.g[2920]=b.h[v(a)];a.g[37378]=b.h[v(a)];a.g[35839]=b.h[v(a)];a.g[27080]=Object.getOwnPropertyDescriptor(a.g[2920],a.g[37378]);a.g[39506]={set:a.g[35839],configurable:!0,enumerable:!0};a.g[27080]&&typeof a.g[27080].get==="function"&&(a.g[39506].get=a.g[27080].get);Object.defineProperty(a.g[2920],a.g[37378],a.g[39506]);break;case 12182:a.g[29248]=v(a);a.g[52124]=
b.h[v(a)];a.g[47986]=b.h[v(a)];b.h[a.g[29248]]=delete a.g[52124][a.g[47986]];break;case 3376:a.g[16541]=5;a.g[62634]=b.h[2];b.h[a.g[16541]]=a.g[62634]+b.h[3];break;case 4123:a.g[63658]=5;a.g[40080]=b.h[3];a.g[37378]=b.h[4];b.h[a.g[63658]]=a.g[40080][a.g[37378]];break;case 27100:a.g[16541]=v(a);b.h[a.g[16541]]=-b.h[v(a)];break;case 35987:a.g[16541]=3;b.h[a.g[16541]]=b.h[6];break;case 59134:a.g[11440]=5;b.h[a.g[11440]]=x(a,4,0);break;case 47879:a.g[59573]=v(a);v(a);b.h[a.g[59573]]=void 0;break;case 59967:a.g[16541]=
7;a.g[54385]=b.h[0];b.h[a.g[16541]]=a.g[54385]-b.h[6];break;case 37122:a.g[16541]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[16541]]=a.g[62634]>=b.h[v(a)];break;case 18522:a.g[1489]=v(a);a.g[38065]=b.h[v(a)];b.h[a.g[1489]]=a.g[38065]===b.h[v(a)];break;case 60376:a.g[19925]=b.h[3];z(a,b);if(a.j.length===0)return a.g[19925];b.o===null||typeof a.g[19925]==="object"&&a.g[19925]!==null||(a.g[19925]=b.o);a.g[53519]=a.j.pop();a.g[53519].h[b.G]=a.g[19925];a.i=a.g[53519];break;case 28102:a.g[16541]=v(a);a.g[10179]=
v(a);a.g[38805]=Array(a.g[10179]);for(a.g[37753]=0;a.g[37753]<a.g[10179];a.g[37753]++)a.g[38805][a.g[37753]]=b.h[v(a)];b.h[a.g[16541]]=a.g[38805];break;case 55907:a.g[249]=v(a);a.g[13793]=v(a);a.g[7488]=v(a);a.g[33443]=v(a);a.g[59975]=v(a);a.g[44466]=Array(a.g[59975]);for(a.g[33125]=0;a.g[33125]<a.g[59975];a.g[33125]++)a.g[5413]=v(a),a.g[61217]=v(a),a.g[44466][a.g[33125]]={V:a.g[5413],M:a.g[61217]};a.g[29776]={C:a.g[7488],L:a.g[33443],R:a.g[13793],X:a.g[44466]};a.g[32226]=new m(a.g[29776]);for(a.g[33125]=
0;a.g[33125]<a.g[44466].length;a.g[33125]++)a.g[49053]=a.g[44466][a.g[33125]],a.g[49053].V?a.g[32226].D.push(w(a,b,a.g[49053].M)):a.g[32226].D.push(b.K.D[a.g[49053].M]);var q=a;a.g[31999]=function(l){return function(){for(var t=Array.prototype.slice.call(arguments),y=new p(q.u,l.v.L,q.O,q.m),u=new n(l,this==null?q.m:this,0),r=0;r<t.length;r++)u.h[r]=t[r];u.h[l.v.C]=t;y.i=u;return A(y)}}(a.g[32226]);a.g[31999][c]=a.g[32226];a.g[31999].prototype=a.g[32226].prototype;b.h[a.g[249]]=a.g[31999];break;case 138:a.g[16541]=
5;b.h[a.g[16541]]=x(a,5,58082);break;case 48909:a.g[16541]=v(a);a.g[41461]=b.h[v(a)];b.h[a.g[16541]]=a.g[41461]%b.h[v(a)];break;case 13149:a.g[14138]=v(a);a.g[52124]=b.h[v(a)];a.g[37378]=b.h[v(a)];b.h[a.g[14138]]=a.g[52124][a.g[37378]];break;case 63724:a.g[55552]=4;a.g[21339]=44;b.h[a.g[55552]]||(b.l=a.g[21339]);break;case 25433:a.g[16541]=4;b.h[a.g[16541]]=b.h[5];break;case 5005:a.g[52124]=b.h[v(a)];a.g[37378]=b.h[v(a)];a.g[3547]=b.h[v(a)];Reflect.set(a.g[52124],a.g[37378],a.g[3547]);break;case 44357:b.F.push({U:v(a),
S:v(a),T:a.j.length});break;case 52184:a.g[16541]=v(a);b.h[a.g[16541]]=~b.h[v(a)];break;case 17926:b.F.pop();break;case 17061:a.g[16541]=v(a);b.h[a.g[16541]]=+b.h[v(a)];break;case 739:a.g[22118]=v(a);a.g[36985]=b.h[v(a)];a.g[41836]=v(a);a.g[59944]=Array(a.g[41836]);for(a.g[33125]=0;a.g[33125]<a.g[41836];a.g[33125]++)a.g[59944][a.g[33125]]=b.h[v(a)];if(a.g[36985]&&a.g[36985][c]){a.g[6850]=a.g[36985][c];a.g[30557]=Object.create(a.g[6850].prototype||null);a.g[58907]=new n(a.g[6850],a.g[30557],a.g[22118]);
a.g[58907].o=a.g[30557];for(a.g[33125]=0;a.g[33125]<a.g[59944].length;a.g[33125]++)a.g[58907].h[a.g[33125]]=a.g[59944][a.g[33125]];a.g[58907].h[a.g[6850].v.C]=a.g[59944];a.j.push(a.i);a.i=a.g[58907]}else b.h[a.g[22118]]=Reflect.construct(a.g[36985],a.g[59944]);break;case 16825:a.g[16541]=v(a);a.g[3993]=b.h[v(a)];b.h[a.g[16541]]=a.g[3993]in b.h[v(a)];break;case 62846:a.g[16541]=6;b.h[a.g[16541]]=x(a,0,19941);break;case 41878:a.g[16541]=v(a);a.g[35268]=b.h[v(a)];b.h[a.g[16541]]=a.g[35268]==b.h[v(a)];
break;case 46432:a.g[29035]=4;a.g[62634]=b.h[2];b.h[a.g[29035]]=a.g[62634]<=b.h[3];break;case 51142:b.l=v(a);break;case 29761:a.g[44199]=v(a);a.g[7487]=b.h[v(a)];b.h[a.g[44199]]=a.g[7487]>>b.h[v(a)];break;case 47732:a.g[16541]=v(a);b.h[a.g[16541]]=b.W;break;case 21541:a.g[16076]=9;a.g[21339]=75;b.h[a.g[16076]]||(b.l=a.g[21339]);break;case 14784:a.g[16541]=3;b.h[a.g[16541]]=x(a,1,30115);break;case 51607:a.g[16541]=v(a);a.g[65339]=b.h[v(a)];a.g[47106]=b.h[v(a)];if(typeof a.g[47106]==="function")b.h[a.g[16541]]=
a.g[65339]instanceof a.g[47106];else{a.g[5038]=a.g[47106].prototype;a.g[21339]=Object.getPrototypeOf(a.g[65339]);for(a.g[25853]=!1;a.g[21339]!==null;){if(a.g[21339]===a.g[5038]){a.g[25853]=!0;break}a.g[21339]=Object.getPrototypeOf(a.g[21339])}b.h[a.g[16541]]=a.g[25853]}break;case 55835:a.g[16541]=v(a);b.h[a.g[16541]]=h(b.K.D[v(a)]);break;case 29844:a.g[42713]=v(a);a.g[1817]=x(a);if(!(a.g[1817]in a.m))throw new ReferenceError(`${a.g[1817]} is not defined`);b.h[a.g[42713]]=a.m[a.g[1817]];break;case 24699:a.g[16541]=
5;a.g[62634]=b.h[2];b.h[a.g[16541]]=a.g[62634]+b.h[4];break;case 44361:a.g[16541]=v(a);a.g[52124]=b.h[v(a)];a.g[15140]=[];if(a.g[52124]!==null&&a.g[52124]!==void 0)for(a.g[23643]=Object.create(null),a.g[61494]=Object(a.g[52124]);a.g[61494]!==null;){a.g[46538]=Object.getOwnPropertyNames(a.g[61494]);for(a.g[33125]=0;a.g[33125]<a.g[46538].length;a.g[33125]++)a.g[7176]=a.g[46538][a.g[33125]],a.g[7176]in a.g[23643]||(a.g[23643][a.g[7176]]=!0,a.g[34638]=Object.getOwnPropertyDescriptor(a.g[61494],a.g[7176]),
a.g[34638]&&a.g[34638].enumerable&&a.g[15140].push(a.g[7176]));a.g[61494]=Object.getPrototypeOf(a.g[61494])}b.h[a.g[16541]]={N:a.g[15140],P:0};break;case 49820:a.g[16541]=v(a);b.h[a.g[16541]]=x(a);break;case 51817:a.g[38915]=b.h[4];z(a,b);if(a.j.length===0)return a.g[38915];b.o===null||typeof a.g[38915]==="object"&&a.g[38915]!==null||(a.g[38915]=b.o);a.g[23776]=a.j.pop();a.g[23776].h[b.G]=a.g[38915];a.i=a.g[23776];break;case 64967:a.g[52124]=b.h[v(a)];a.g[37378]=b.h[v(a)];a.g[11470]=b.h[v(a)];a.g[12672]=
Object.getOwnPropertyDescriptor(a.g[52124],a.g[37378]);a.g[60061]={get:a.g[11470],configurable:!0,enumerable:!0};a.g[12672]&&typeof a.g[12672].set==="function"&&(a.g[60061].set=a.g[12672].set);Object.defineProperty(a.g[52124],a.g[37378],a.g[60061]);break;case 45309:a.g[7138]=v(a);a.g[18365]=v(a);a.g[49429]=v(a);for(a.g[9236]=a.g[18365];a.g[9236]<a.g[49429];a.g[9236]++)a.u[a.g[7138]+(a.g[9236]-a.g[18365])]=a.u[a.g[9236]];break;case 49746:a.g[12540]=v(a);k(b.K.D[a.g[12540]],b.h[v(a)]);break;case 7780:a.g[16541]=
3;a.g[1817]=x(a,2,31810);if(!(a.g[1817]in a.m))throw new ReferenceError(`${a.g[1817]} is not defined`);b.h[a.g[16541]]=a.m[a.g[1817]];break;case 20641:a.g[16541]=v(a);a.g[7422]=b.h[v(a)];a.g[11407]=v(a);a.g[59944]=Array(a.g[11407]);for(a.g[33125]=0;a.g[33125]<a.g[11407];a.g[33125]++)a.g[59944][a.g[33125]]=b.h[v(a)];if(a.g[7422]&&a.g[7422][c]){a.g[7358]=a.g[7422][c];a.g[58907]=new n(a.g[7358],a.m,a.g[16541]);for(a.g[33125]=0;a.g[33125]<a.g[59944].length;a.g[33125]++)a.g[58907].h[a.g[33125]]=a.g[59944][a.g[33125]];
a.g[58907].h[a.g[7358].v.C]=a.g[59944];a.j.push(a.i);a.i=a.g[58907]}else b.h[a.g[16541]]=a.g[7422].apply(null,a.g[59944]);break;case 5381:a.g[16541]=v(a);a.g[14415]=b.h[v(a)];b.h[a.g[16541]]=a.g[14415]-b.h[v(a)];break;case 60964:a.g[1E3]=9;a.g[62634]=b.h[5];b.h[a.g[1E3]]=a.g[62634]>b.h[8];break;case 19072:a.g[12158]=v(a);a.g[21339]=v(a);b.h[a.g[12158]]&&(b.l=a.g[21339]);break;case 51960:a.g[16541]=3;b.h[a.g[16541]]=b.h[2];break;case 30357:a.g[16541]=v(a);a.g[63497]=b.h[v(a)];a.g[57844]=v(a);a.g[63497].P>=
a.g[63497].N.length?b.l=a.g[57844]:b.h[a.g[16541]]=a.g[63497].N[a.g[63497].P++];break;case 20745:a.g[16541]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[16541]]=a.g[62634]/b.h[v(a)];break;case 11726:a.g[9620]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[9620]]=a.g[62634]&b.h[v(a)];break;case 48568:a.g[5190]=3;b.h[a.g[5190]]=x(a,4,0);break;case 3645:a.g[22553]=v(a);a.g[807]=x(a);a.g[645]=Object.prototype.hasOwnProperty.call(a.m,a.g[807])?a.m[a.g[807]]:void 0;b.h[a.g[22553]]=typeof a.g[645];break;case 46061:a.g[34726]=v(a);
a.g[59851]=v(a);a.g[62133]={};for(a.g[33125]=0;a.g[33125]<a.g[59851];a.g[33125]++)a.g[37378]=b.h[v(a)],a.g[3547]=b.h[v(a)],a.g[62133][a.g[37378]]=a.g[3547];b.h[a.g[34726]]=a.g[62133];break;case 20491:debugger;break;case 24674:a.g[51590]=1;b.h[a.g[51590]]=b.h[3];break;case 60658:a.g[16541]=v(a);a.g[62634]=b.h[v(a)];b.h[a.g[16541]]=a.g[62634]<<b.h[v(a)];break;case 8845:a.g[16541]=2;b.h[a.g[16541]]=b.h[3];break;default:throw Error("Unknown opcode: "+d+" at pc "+(b.l-1));case 59199:a.g[16541]=v(a);a.g[62634]=
b.h[v(a)];b.h[a.g[16541]]=a.g[62634]+b.h[v(a)];break;case 5385:a.g[39284]=4;b.h[a.g[39284]]=x(a,3,32194);break;case 20918:a.g[16541]=v(a);a.g[16160]=b.h[v(a)];b.h[a.g[16541]]=a.g[16160]|b.h[v(a)];break;case 25652:a.g[16541]=8;b.h[a.g[16541]]=x(a,0,19941);break;case 51993:a.g[14091]=v(a);a.g[20393]=b.h[v(a)];b.h[a.g[14091]]=a.g[20393]*b.h[v(a)];break;case 29458:a.g[27021]=4;b.h[a.g[27021]]=b.h[0];break;case 38570:throw b.h[v(a)];case 21903:a.g[16541]=v(a);a.g[46842]=b.h[v(a)];b.h[a.g[16541]]=a.g[46842]<
b.h[v(a)];break;case 17068:a.g[16541]=5;b.h[a.g[16541]]=b.h[0];break;case 26163:a.g[55552]=v(a);a.g[16422]=v(a);b.h[a.g[55552]]||(b.l=a.g[16422]);break;case 28425:a.g[16541]=v(a);b.h[a.g[16541]]=typeof b.h[v(a)];break;case 63202:a.g[60330]=v(a);b.h[a.g[60330]]=b.h[v(a)];break;case 31805:a.g[53668]=v(a);b.h[a.g[53668]]=!b.h[v(a)];break;case 57225:b.l=59}}catch(l){b=null;for(d=a.i;;){if(d.F.length>0){b=d;break}z(a,d);if(a.j.length===0)break;d=a.j.pop();a.i=d}if(!b)throw l;d=b.F.pop();a.j.length=d.T;
b.h[d.S]=l;b.l=d.U;a.i=b}}}var B={},C;for(C of Object.getOwnPropertyNames(globalThis))B[C]=globalThis[C];if(typeof window!=="undefined"){B.window=window;for(C of Object.getOwnPropertyNames(window))B[C]=window[C]}B.undefined=void 0;B.Infinity=Infinity;B.NaN=NaN;
A(new p(function(a){a=typeof Buffer!=="undefined"?Buffer.from(a,"base64"):Uint8Array.from(atob(a),function(d){return d.charCodeAt(0)});for(var e=new Uint16Array(a.length/2),b=0;b<e.length;b++)e[b]=a[b*2]|a[b*2+1]<<8;return e}("/bAEAFIAWwCNE5aj8uz9sA2/zi2qlqqWY9r9sBEAWwBtAKFQ52DnYD0OPQ5FrTNmCVGPVRnLbEC2UZV2+Lz4vMyRB7sJb/2wJwBtAHIAtlE/58Zt/bDMkf2wMAByAHQAzJF6Hv2wNgB0AHkA3GnOLT18B2Y/5/2wPwB5AIUAB7v4vKKxBNYNv6KxPXxFrQTWY9o9fO2z/bBPAIUAiABJrVLCPXxj2gMAMgABAAoAAABiYOxxjSLAOWC17PhkHgkVGxChUAYAAQABAAIAorEHAAMABQACAAIABgD4ys9Se2DYsWwHuL3Y64oA2LF+9ZOMEnOsQn71P+rZkjRkJO4lVDANWWONItRkid9pyv7mf70="),0,
[19940,30138,"IXwsfCp8NnwpfCt8LXw=","rn2sfaN9",void 0,58082],B));
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
- [x] template literals (**ES6**)

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
- [x] micro opcodes (Break opcodes into sub-opcodes)
- [x] specialized opcodes (Create specific opcodes for opcode+operand pairs)
- [x] aliased opcodes (Create duplicate opcodes, including variants with shuffled operand order)
- [x] encoded bytecode array
- [x] self-modifying bytecode
- [x] timing checks
- [ ] low-level bytecode obfuscations
- [x] dispatcher (Encoded jumps)
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

#### `dispatcher` (true/false)

Creates a middleman block to process jumps.

```js
// Input Code
if (true) {
  console.log("Hello world!");
}

// Before
// fn_0_0:
// [0, 0, 0, 0],        LOAD_CONST  reg[0] = true                         1:4-1:8
// [40, 0, 29],         JUMP_IF_FALSE  [0, if_else_1]                     1:0-3:1
// [2, 0, 1, 0],        LOAD_GLOBAL  reg[0] = console                     2:2-2:9
// [0, 1, 2, 0],        LOAD_CONST  reg[1] = "log"                        2:2-2:29
// [8, 2, 0, 1],        GET_PROP  reg[2] = reg[0][reg[1]]                 2:2-2:29
// [0, 1, 3, 0],        LOAD_CONST  reg[1] = "Hello world!"               2:14-2:28
// [43, 3, 0, 2, 1, 1], CALL_METHOD  reg[3] = reg[2](recv=reg[0], 1 args) 2:2-2:29
// if_else_1:
// [0, 0, 4, 0],        LOAD_CONST  reg[0] = undefined                    
// [45, 0],             RETURN  reg[0]              

// What this looks like decompiled:
// fn_0_0:
r0 = true
if (!r0) goto if_else_1
  r0 = console
  r1 = "log"
  r2 = r0[r1]          // console.log
  r1 = "Hello world!"
  r3 = r2.call(r0, r1) // console.log("Hello world!")
// if_else_1:
  r0 = undefined
  return r0            

// After
// fn_0_0:
// [47, 2, 57, 2, 5, 0], MAKE_CLOSURE  reg[2] PC=fn_2_3 (params=2 regs=5 upvalues=0)
// [0, 3, 0, 0],        LOAD_CONST  reg[3] = true                         1:4-1:8
// [41, 3, 21],         JUMP_IF_TRUE  [3, if_else_1_skip_5]               
// [1, 0, 43020],       LOAD_INT  reg[0] = if_else_1                      
// [1, 1, 40151],       LOAD_INT  reg[1] = 40151                          
// [39, 49],            JUMP  dispatcher_4                                
// if_else_1_skip_5:
// [2, 3, 1, 0],        LOAD_GLOBAL  reg[3] = console                     2:2-2:9
// [0, 4, 2, 0],        LOAD_CONST  reg[4] = "log"                        2:2-2:29
// [8, 5, 3, 4],        GET_PROP  reg[5] = reg[3][reg[4]]                 2:2-2:29
// [0, 4, 3, 0],        LOAD_CONST  reg[4] = "Hello world!"               2:14-2:28
// [43, 6, 3, 5, 1, 4], CALL_METHOD  reg[6] = reg[5](recv=reg[3], 1 args) 2:2-2:29
// if_else_1:
// [0, 3, 4, 0],        LOAD_CONST  reg[3] = undefined                    
// [45, 3],             RETURN  reg[3]                                    
// dispatcher_4:
// [42, 0, 2, 2, 0, 1], CALL  reg[0] = reg[2](reg[0], reg[1])             
// [58, 0],             JUMP_REG  PC = reg[0]                             
// fn_2_3:              
// [18, 2, 0, 1],       BXOR  [2, 0, 1]              
// [0, 3, 5, 0],        LOAD_CONST  reg[3] = 52048                        
// [11, 4, 2, 3],       ADD  [4, 2, 3]                                    
// [0, 2, 6, 0],        LOAD_CONST  reg[2] = 65535                        
// [16, 3, 4, 2],       BAND  [3, 4, 2]                                   
// [45, 3],             RETURN  reg[3]                                    

// What this looks like decompiled:
// fn_0_0:
r2 = MakeClosure(fn_2_3, params=2)
r3 = true
if (r3) goto if_else_1_skip
  r0 = 43020
  r1 = 40151
  goto dispatcher
// if_else_1_skip:
  r3 = console
  r4 = "log"
  r5 = r3[r4]          // console.log
  r4 = "Hello world!"
  r6 = r5.call(r3, r4) // console.log("Hello world!")
// if_else_1:
  r3 = undefined
  return r3

// dispatcher:
  r0 = r2(r0, r1)      // decode(encodedPC, siteKey)
  goto *r0             // indirect jump

// fn_2_3:
function decode(x, k) {
  return ((x ^ k) + 52048) & 65535; 
}
```

#### `macroOpcodes` (true/false)

Combines multiple opcodes commonly used from your bytecode.

```js
// Input Code
console.log("Hello world!");
console.log("Hello world!");

// Before
// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console                     1:0-1:7
// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        1:0-1:27
// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               1:0-1:27
// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello world!"               1:12-1:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)1:0-1:27
// [2, 1, 0],           LOAD_GLOBAL  reg[1] = console                     2:0-2:7
// [0, 2, 1],           LOAD_CONST  reg[2] = "log"                        2:0-2:27
// [8, 3, 1, 2],        GET_PROP  [3, 1, 2]                               2:0-2:27
// [0, 4, 2],           LOAD_CONST  reg[4] = "Hello world!"               2:12-2:26
// [43, 5, 1, 3, 1, 4], CALL_METHOD  reg[5] = method(recv=reg[1], fn=reg[3], 1 args)2:0-2:27

// After
// [5074, 1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4], LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST,CALL_METHOD  [1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4]2:0-2:7
// [5074, 1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4], LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST,CALL_METHOD  [1, 0, 2, 1, 3, 1, 2, 4, 2, 5, 1, 3, 1, 4]3:0-3:7

// What the opcode "LOAD_GLOBAL,LOAD_CONST,GET_PROP,LOAD_CONST,CALL_METHOD" (5074) looks like:
case 5074:
  // LOAD_GLOBAL
  var dst = this._operand();
  var globalName = this._constant();
  if (!(globalName in this.globals)) {
    throw new ReferenceError(`${globalName} is not defined`);
  }
  frame.regs[dst] = this.globals[globalName];
  // LOAD_CONST
  var dst_1 = this._operand();
  frame.regs[dst_1] = this._constant();
  // GET_PROP
  // dst = regs[obj][regs[key]]
  var dst_2 = this._operand();
  var obj = frame.regs[this._operand()];
  var key = frame.regs[this._operand()];
  frame.regs[dst_2] = obj[key];
  // LOAD_CONST
  var dst_3 = this._operand();
  frame.regs[dst_3] = this._constant();
  // CALL_METHOD
  // dst, receiverReg, calleeReg, argc, [argReg...]
  var dst_4 = this._operand();
  var receiver = frame.regs[this._operand()];
  var callee = frame.regs[this._operand()];
  var argc = this._operand();
  var args = new Array(argc);
  for (var i = 0; i < argc; i++) args[i] = frame.regs[this._operand()];
  if (callee && callee[CLOSURE_SYM]) {
    var c = callee[CLOSURE_SYM];
    var f = new Frame(c, frame._pc, frame, receiver, dst_4);
    for (var i = 0; i < args.length; i++) f.regs[i] = args[i];
    f.regs[c.fn.paramCount] = args;
    this._frameStack.push(this._currentFrame);
    this._currentFrame = f;
  } else {
    frame.regs[dst_4] = callee.apply(receiver, args);
  }
  break;
```

#### `microOpcodes` (true/false)

Breaks opcodes into mulitple sub-opcodes.

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

// What the opcodes "MICRO_LOAD_CONST_0" (58) and "MICRO_LOAD_CONST_1" (59) look like:
case 58:
    // MICRO_LOAD_CONST_0
    this._internals[0] = this._operand();
    break;
case 59:
    // MICRO_LOAD_CONST_1
    frame.regs[this._internals[0]] = this._constant();
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

- Register based VM
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