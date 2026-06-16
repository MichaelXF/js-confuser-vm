# JS Confuser VM

  [![NPM](https://img.shields.io/badge/NPM-%23000000.svg?style=for-the-badge&logo=npm&logoColor=white)](https://npmjs.com/package/js-confuser-vm) [![GitHub](https://img.shields.io/badge/github-%23121011.svg?style=for-the-badge&logo=github&logoColor=white)](https://github.com/MichaelXF/js-confuser-vm) [![Netlify](https://img.shields.io/badge/netlify-%23000000.svg?style=for-the-badge&logo=netlify&logoColor=#00C7B7)](https://js-confuser.com/vm)


- Supports ES5 and limited ES6 features. No complex features, such as async and generators aren't supported.
- Experimental. Expect issues.
- [Try the web version.](https://js-confuser.com/vm)

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
  dispatcher: true, // create middleman blocks to process jumps?
  controlFlowFlattening: true, // flatten the control flow of your program into a convoluted state machine?
  stringConcealing: true, // base64-encode strings to conceal plain-text values?
  macroOpcodes: true, // create combined opcodes for repeated instruction sequences?
  specializedOpcodes: true, // create specialized opcodes for commonly used opcode+operand pairs?
  aliasedOpcodes: true, // create duplicate opcodes for commonly used opcodes?
  timingChecks: true, // add timing checks to detect debuggers?
  concealConstants: true, // conceal strings and integers in the constant pool?
  classObfuscation: true, // obfuscate the VM runtime classes?
  minify: true, // pass final output through Google Closure Compiler? (Renames VM class properties)
}).then(result => {
  console.log(result.code)
})

/*
function ba(d,q,e,m){this.F=d;this.P=e;this.C=m;this.l=[];this.J=[];this.g=Array(q).fill(void 0);this.v=q;this.o=new f(new ca({B:0,m:q,U:0}),void 0,0,0)}function da(d){return typeof Buffer!=="undefined"?Buffer.from(d,"base64"):Uint8Array.from(atob(d),function(q){return q.charCodeAt(0)})}function ea(d,q){this.g=d;this.G=q;this.H=!1;this.M=void 0}var n=new WeakMap;function f(d,q,e,m){this.A=d;this.h=m;this.j=d.i.U;this.$=q!==void 0?q:void 0;this.D=e!==void 0?e:0;this.u=null;this.I=[]}
function ca(d){this.i=d;this.K=[];this.prototype={}}function B(d,q,e){q=q??I(d);e=e??I(d);d=d.P[q];if(!e)return d;if(typeof d==="number")return d^e;d=da(d);q="";for(var m=0;m<d.length/2;m++)q+=String.fromCharCode((d[m*2]|d[m*2+1]<<8)^e+m&65535);return q}function fa(d){return d.H?d.M:d.g[d.G]}function ra(d,q,e){q=q.h+e;for(e=0;e<d.J.length;e++){var m=d.J[e];if(!m.H&&m.G===q)return m}m=new ea(d.g,q);d.J.push(m);return m}function sa(d,q){d.H?d.M=q:d.g[d.G]=q}function I(d){return d.F[d.o.j++]}
function M(d,q){var e=q.h,m=q.h+q.A.i.m;d.J=d.J.filter(function(y){return!y.H&&y.G>=e&&y.G<m?(y.M=y.g[y.G],y.H=!0,!1):!0})}function P(d,q,e){for(e=q+e;d.g.length<e;)d.g.push(void 0);for(;q<e;q++)d.g[q]=void 0}
function ta(d){for(var q=performance.now();;){var e=d.o;if(e.j>=d.F.length)break;var m=e.j++;m=d.F[m];var y=performance.now(),va=y-q>1E3;q=y;if(va){for(var g=0;g<d.F.length;g++)d.F[g]=0;for(m=e.h;m<d.v;m++)d.g[m]=void 0;m=56794;e.j=d.F.length}try{var b=d.g,c=e.h;switch(m){case 27304:var w=b[c+I(d)],z=b[c+I(d)],wa=b[c+I(d)],H=Object.getOwnPropertyDescriptor(w,z);e={set:wa,configurable:!0,enumerable:!0};H&&typeof H.get==="function"&&(e.get=H.get);Object.defineProperty(w,z,e);break;case 3275:e.j=287;
break;case 51732:var a=1;b[c+a]=B(d,13,0);break;case 38496:var k=b[c+29];M(d,e);var x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);var t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 51626:a=I(d);b[c+a]=e.$;break;case 53773:k=b[c+3];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 65442:a=
7;b[c+a]=45008;break;case 54897:a=23;b[c+a]=B(d,21,61364);break;case 60096:a=I(d);var h=b[c+I(d)];b[c+a]=h>>>b[c+I(d)];break;case 31086:var p=31,l=507;b[c+p]||(e.j=l);break;case 55707:a=30;b[c+a]=B(d,13,0);break;case 45866:debugger;break;case 3739:a=I(d);var ha=I(d),ia=Array(ha);for(g=0;g<ha;g++)ia[g]=b[c+I(d)];b[c+a]=ia;break;case 34277:a=27;b[c+a]=55886;break;case 6475:a=27;b[c+a]=19472;break;case 23398:a=27;b[c+a]=22253;break;case 16267:a=27;b[c+a]=47829;break;case 62373:a=I(d);w=b[c+I(d)];var X=
b[c+I(d)];if(typeof X==="function")b[c+a]=w instanceof X;else{var xa=X.prototype;l=Object.getPrototypeOf(w);for(e=!1;l!==null;){if(l===xa){e=!0;break}l=Object.getPrototypeOf(l)}b[c+a]=e}break;case 728:var ya=I(d),ja=I(d),za=I(d);for(e=ja;e<za;e++)d.F[ya+(e-ja)]=d.F[e];break;case 23697:a=28;b[c+a]=59819;break;case 30800:a=I(d);h=b[c+I(d)];b[c+a]=h===b[c+I(d)];break;case 52519:a=28;b[c+a]=54421;break;case 57471:p=12;l=331;b[c+p]&&(e.j=l);break;case 6233:a=27;b[c+a]=214;break;case 2122:a=28;b[c+a]=6034;
break;case 45689:a=2;b[c+a]=b[c+3];break;case 21693:a=29;b[c+a]=B(d,13,0);break;case 59763:p=9;l=23;b[c+p]&&(e.j=l);break;case 52409:a=26;b[c+a]=11895;break;case 43733:a=I(d);h=b[c+I(d)];b[c+a]=h>>b[c+I(d)];break;case 6977:p=18;l=382;b[c+p]&&(e.j=l);break;case 914:a=7;b[c+a]=b[c+6];break;case 9768:k=b[c+2];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 30839:a=I(d);
h=b[c+I(d)];b[c+a]=h*b[c+I(d)];break;case 33249:a=27;b[c+a]=5007;break;case 13193:a=27;b[c+a]=32650;break;case 9579:a=8;b[c+a]=11538;break;case 23885:a=8;b[c+a]=27166;break;case 44775:k=b[c+1];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 58411:a=28;b[c+a]=33223;break;case 61434:a=3;h=b[c+4];b[c+a]=h&b[c+2];break;case 53370:a=27;b[c+a]=26969;break;case 60585:a=27;
b[c+a]=11124;break;case 35870:a=3;b[c+a]=b[c+0];break;case 2359:a=I(d);var ka=b[c+I(d)],C=b[c+I(d)],D=I(d);if(D===1346325351)var u=b[c+I(d)];else for(u=Array(D),g=0;g<D;g++)u[g]=b[c+I(d)];var r=C&&n.get(C);if(r){var v=d.v;P(d,v,r.i.m);d.v=v+r.i.m;var J=new f(r,ka,a,v);if(r.i.L){var E=r.i.B-1;for(g=0;g<E;g++)d.g[v+g]=g<u.length?u[g]:void 0;d.g[v+E]=u.slice(E)}else for(g=0;g<u.length&&g<r.i.m;g++)d.g[v+g]=u[g];r.i.B<r.i.m&&(d.g[v+r.i.B]=u);d.l.push(d.o);d.o=J}else b[c+a]=C.apply(ka,u);break;case 33199:a=
27;b[c+a]=51778;break;case 16523:a=29;b[c+a]=b[c+1];break;case 52773:a=26;b[c+a]=8604;break;case 41754:a=27;b[c+a]=65235;break;case 55073:a=26;b[c+a]=41150;break;case 30215:a=5;b[c+a]=b[c+0];break;case 12986:a=1;b[c+a]=b[c+2];break;case 52156:a=27;b[c+a]=17892;break;case 31804:a=I(d);b[c+a]=fa(e.A.K[I(d)]);break;case 25312:a=28;b[c+a]=29501;break;case 38178:a=28;b[c+a]=5409;break;case 11443:a=29;b[c+a]=B(d,9,48146);break;case 14362:a=1;b[c+a]=b[c+30];break;case 19456:a=29;b[c+a]=B(d,10,53642);break;
case 3282:a=7;b[c+a]=12018;break;case 14125:k=b[c+2];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 50918:a=28;b[c+a]=10738;break;case 51949:a=27;b[c+a]=64988;break;case 2059:a=27;b[c+a]=61594;break;case 52528:a=7;b[c+a]=19983;break;case 3978:a=27;b[c+a]=9370;break;case 25228:a=26;b[c+a]=63581;break;case 4992:a=28;b[c+a]=44381;break;case 28745:a=27;b[c+a]=40319;break;
case 5201:a=I(d);h=b[c+I(d)];b[c+a]=h>=b[c+I(d)];break;case 48708:a=8;b[c+a]=44102;break;case 49539:a=I(d);h=b[c+I(d)];b[c+a]=h==b[c+I(d)];break;case 40068:a=6;h=b[c+0];b[c+a]=h-b[c+30];break;case 43644:a=2;h=b[c+0];b[c+a]=h^b[c+1];break;case 62162:p=I(d);l=I(d);b[c+p]&&(e.j=l);break;case 49692:a=4;b[c+a]=B(d,9,48146);break;case 36265:p=24;l=433;b[c+p]&&(e.j=l);break;case 18996:a=17;b[c+a]=B(d,18,31254);break;case 41259:a=7;b[c+a]=B(d,14,19695);break;case 30356:a=27;b[c+a]=4133;break;case 30951:e.I.push({X:I(d),
R:I(d),S:d.l.length});break;case 58823:a=26;b[c+a]=58954;break;case 62570:e.I.push({W:I(d),V:I(d),Z:I(d),aa:I(d),S:d.l.length});break;case 51978:a=8;b[c+a]=B(d,1,2776);break;case 3766:a=8;b[c+a]=10594;break;case 4542:p=23;l=135;b[c+p]&&(e.j=l);break;case 52019:a=8;b[c+a]=b[c+7];break;case 24314:a=I(d);var S=b[c+I(d)],Aa=I(d);S.T>=S.O.length?e.j=Aa:b[c+a]=S.O[S.T++];break;case 26863:a=26;b[c+a]=28504;break;case 4731:a=27;b[c+a]=57674;break;case 45482:a=29;b[c+a]=B(d,9,48146);break;case 59270:a=I(d);
h=b[c+I(d)];b[c+a]=h+b[c+I(d)];break;case 30848:a=26;b[c+a]=34955;break;case 21700:a=20;h=b[c+8];b[c+a]=h===b[c+19];break;case 46334:k=b[c+2];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 13136:a=I(d);C=b[c+I(d)];D=I(d);if(D===1346325351)u=b[c+I(d)];else for(u=Array(D),g=0;g<D;g++)u[g]=b[c+I(d)];if(r=C&&n.get(C)){var la=Object.create(r.prototype||null);v=d.v;P(d,
v,r.i.m);d.v=v+r.i.m;J=new f(r,la,a,v);if(r.i.L){E=r.i.B-1;for(g=0;g<E;g++)d.g[v+g]=g<u.length?u[g]:void 0;d.g[v+E]=u.slice(E)}else for(g=0;g<u.length&&g<r.i.m;g++)d.g[v+g]=u[g];r.i.B<r.i.m&&(d.g[v+r.i.B]=u);J.u=la;d.l.push(d.o);d.o=J}else b[c+a]=Reflect.construct(C,u);break;case 22903:a=26;h=b[c+8];b[c+a]=h===b[c+25];break;case 8165:a=I(d);h=b[c+I(d)];b[c+a]=h-b[c+I(d)];break;case 57345:a=27;b[c+a]=42023;break;case 30575:e.j=b[c+I(d)];break;case 12185:a=I(d);I(d);b[c+a]=void 0;break;case 25230:a=
7;b[c+a]=44230;break;case 9110:a=29;w=b[c+2];z=b[c+3];b[c+a]=w[z];break;case 2408:a=27;b[c+a]=16167;break;case 43340:a=28;b[c+a]=15123;break;case 375:a=27;b[c+a]=37792;break;case 61363:a=26;b[c+a]=56165;break;case 45914:a=27;b[c+a]=59072;break;case 43243:a=15;b[c+a]=B(d,17,34472);break;case 60738:a=2;b[c+a]=B(d,26,9252);break;case 9014:a=28;b[c+a]=19641;break;case 59995:a=26;b[c+a]=33559;break;case 6861:e.j=b[c+27];break;case 30584:e.I.pop();break;case 26717:a=27;b[c+a]=49516;break;case 53260:a=7;
b[c+a]=33291;break;case 43900:a=3;b[c+a]=B(d,12,57845);break;case 10766:p=14;l=348;b[c+p]&&(e.j=l);break;case 20871:a=28;b[c+a]=42270;break;case 47625:a=2;var F=B(d,11,11091);if(!(F in d.C))throw new ReferenceError(`${F} is not defined`);b[c+a]=d.C[F];break;case 45744:a=30;h=b[c+1];b[c+a]=h+b[c+2];break;case 51945:a=27;b[c+a]=64978;break;case 48135:a=I(d);h=b[c+I(d)];b[c+a]=h/b[c+I(d)];break;case 12490:a=6;b[c+a]=B(d,0,48833);break;case 38156:a=23;h=b[c+7];b[c+a]=h===b[c+22];break;case 45443:a=18;
b[c+a]=B(d,5,64476);break;case 58487:a=27;b[c+a]=43608;break;case 41062:a=18;h=b[c+8];b[c+a]=h===b[c+17];break;case 49336:p=10;l=321;b[c+p]&&(e.j=l);break;case 22586:a=4;h=b[c+2];b[c+a]=h+b[c+3];break;case 5785:a=28;b[c+a]=64273;break;case 41424:a=2;h=b[c+0];b[c+a]=h^b[c+1];break;case 13057:a=28;b[c+a]=52685;break;case 56997:a=21;b[c+a]=B(d,20,12401);break;case 13072:a=27;b[c+a]=22906;break;case 17372:a=4;h=b[c+1];b[c+a]=h+b[c+29];break;case 54813:a=26;b[c+a]=60773;break;case 58446:a=26;b[c+a]=25862;
break;case 14082:a=3;b[c+a]=b[c+30];break;case 28900:a=I(d);h=b[c+I(d)];b[c+a]=h!=b[c+I(d)];break;case 5356:a=28;b[c+a]=44747;break;case 21091:a=I(d);h=b[c+I(d)];b[c+a]=h%b[c+I(d)];break;case 55496:a=16;h=b[c+8];b[c+a]=h===b[c+15];break;case 8964:a=0;b[c+a]=b[c+6];break;case 19574:a=26;b[c+a]=63328;break;case 58892:a=30;b[c+a]=B(d,9,48146);break;case 16851:a=I(d);h=b[c+I(d)];b[c+a]=h^b[c+I(d)];break;case 29264:a=27;b[c+a]=27633;break;case 1439:a=I(d);b[c+a]=B(d);break;case 27274:a=16;b[c+a]=B(d,4,
39230);break;case 21219:a=I(d);b[c+a]=b[c+I(d)];break;case 31487:a=7;b[c+a]=59380;break;case 16336:a=I(d);F=B(d);if(!(F in d.C))throw new ReferenceError(`${F} is not defined`);b[c+a]=d.C[F];break;case 48989:a=14;h=b[c+8];b[c+a]=h===b[c+13];break;case 41866:a=26;b[c+a]=25437;break;case 59315:a=27;b[c+a]=59668;break;case 45755:a=10;h=b[c+8];b[c+a]=h!==b[c+9];break;case 40780:a=20;b[c+a]=B(d,6,27256);break;case 15310:a=26;b[c+a]=56683;break;case 53587:a=I(d);b[c+a]=~b[c+I(d)];break;case 2860:a=3;b[c+
a]=B(d,25,63889);break;case 61396:a=8;b[c+a]=2154;break;case 50015:a=12;h=b[c+8];b[c+a]=h===b[c+11];break;case 31240:a=26;b[c+a]=37995;break;case 48917:p=26;l=450;b[c+p]&&(e.j=l);break;case 41977:a=27;b[c+a]=52154;break;case 37311:a=25;h=b[c+7];b[c+a]=h===b[c+24];break;case 9266:a=I(d);var Ba=I(d);e={};for(g=0;g<Ba;g++){z=b[c+I(d)];var N=b[c+I(d)];e[z]=N}b[c+a]=e;break;case 38320:p=15;l=67;b[c+p]&&(e.j=l);break;case 65117:a=26;b[c+a]=18271;break;case 55737:p=20;l=399;b[c+p]&&(e.j=l);break;case 64061:a=
27;b[c+a]=63311;break;case 24393:a=I(d);var Ca=I(d),Da=I(d),Ea=I(d),ma=I(d),Fa=I(d),T=Array(ma);for(g=0;g<ma;g++){var Ga=I(d),Ha=I(d);T[g]={Y:Ga,N:Ha}}r=new ca({B:Da,m:Ea,U:Ca,ba:T,L:Fa});for(g=0;g<T.length;g++){var Y=T[g];Y.Y?r.K.push(ra(d,e,Y.N)):r.K.push(e.A.K[Y.N])}var U=d,aa=function(A){return function(){var K=Array.prototype.slice.call(arguments),L=new ba(U.F,A.i.m,U.P,U.C);L.o=new f(A,this==null?U.C:this,0,0);if(A.i.L){for(var Z=A.i.B-1,G=0;G<Z;G++)L.g[G]=G<K.length?K[G]:void 0;L.g[Z]=K.slice(Z)}else for(G=
0;G<K.length&&G<A.i.m;G++)L.g[G]=K[G];A.i.B<A.i.m&&(L.g[A.i.B]=K);return ta(L)}}(r);n.set(aa,r);aa.prototype=r.prototype;b[c+a]=aa;break;case 39651:p=19;l=101;b[c+p]&&(e.j=l);break;case 23213:a=4;h=b[c+2];b[c+a]=h+b[c+3];break;case 37419:e.j=554;break;case 27387:p=I(d);l=I(d);b[c+p]||(e.j=l);break;case 2958:a=I(d);h=b[c+I(d)];b[c+a]=h>b[c+I(d)];break;case 43992:p=30;l=197;b[c+p]||(e.j=l);break;case 38858:a=9;h=b[c+7];b[c+a]=h!==b[c+8];break;case 23280:p=16;l=365;b[c+p]&&(e.j=l);break;case 24807:a=
I(d);h=b[c+I(d)];b[c+a]=h in b[c+I(d)];break;case 49359:a=7;b[c+a]=60100;break;case 31717:a=27;b[c+a]=31190;break;case 61163:a=26;b[c+a]=43553;break;case 45062:var Ia=I(d);sa(e.A.K[Ia],b[c+I(d)]);break;case 5400:a=27;b[c+a]=21191;break;case 22960:a=26;b[c+a]=36296;break;case 30198:a=19;b[c+a]=B(d,19,20565);break;case 31054:a=3;h=b[c+4];b[c+a]=h&b[c+2];break;case 55946:a=27;b[c+a]=50533;break;case 42326:a=2;b[c+a]=B(d,13,0);break;case 47802:a=1;F=B(d,24,5777);if(!(F in d.C))throw new ReferenceError(`${F} is not defined`);
b[c+a]=d.C[F];break;case 45545:a=27;b[c+a]=29788;break;case 36497:a=26;b[c+a]=61501;break;case 16530:k=b[c+3];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 3575:w=b[c+I(d)];z=b[c+I(d)];var Ja=b[c+I(d)];H=Object.getOwnPropertyDescriptor(w,z);e={get:Ja,configurable:!0,enumerable:!0};H&&typeof H.set==="function"&&(e.set=H.set);Object.defineProperty(w,z,e);break;case 58449:a=
27;b[c+a]=11931;break;case 16922:a=15;h=b[c+7];b[c+a]=h===b[c+14];break;case 18529:a=24;h=b[c+8];b[c+a]=h===b[c+23];break;case 20311:a=17;h=b[c+7];b[c+a]=h===b[c+16];break;case 61126:a=27;b[c+a]=44075;break;case 25501:a=11;h=b[c+7];b[c+a]=h===b[c+10];break;case 60915:a=12;b[c+a]=B(d,2,53228);break;case 35705:a=28;b[c+a]=9057;break;case 27643:a=28;b[c+a]=63849;break;case 10397:a=I(d);h=b[c+I(d)];b[c+a]=h<=b[c+I(d)];break;case 38422:a=8;b[c+a]=38938;break;case 24297:w=b[c+I(d)];z=b[c+I(d)];N=b[c+I(d)];
Reflect.set(w,z,N);break;case 52921:a=27;b[c+a]=30719;break;case 61718:p=13;l=50;b[c+p]&&(e.j=l);break;case 2367:a=27;b[c+a]=39190;break;case 30416:p=17;l=84;b[c+p]&&(e.j=l);break;case 15914:a=27;b[c+a]=18317;break;case 56794:e.j=I(d);break;case 45239:a=I(d);h=b[c+I(d)];b[c+a]=h!==b[c+I(d)];break;case 45026:a=27;b[c+a]=50871;break;case 58546:a=26;b[c+a]=31393;break;case 43850:a=28;b[c+a]=16708;break;case 60849:a=27;b[c+a]=12296;break;case 9480:a=28;b[c+a]=33263;break;case 27936:k=b[c+3];M(d,e);x=
e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 37363:a=I(d);w=b[c+I(d)];e=[];if(w!==null&&w!==void 0)for(var na=Object.create(null),O=Object(w);O!==null;){var oa=Object.getOwnPropertyNames(O);for(g=0;g<oa.length;g++){var V=oa[g];if(!(V in na)){na[V]=!0;var pa=Object.getOwnPropertyDescriptor(O,V);pa&&pa.enumerable&&e.push(V)}}O=Object.getPrototypeOf(O)}b[c+a]={O:e,T:0};break;
case 19617:a=13;b[c+a]=B(d,16,60419);break;case 57432:a=28;b[c+a]=13137;break;case 40263:a=I(d);h=b[c+I(d)];b[c+a]=h|b[c+I(d)];break;case 64236:a=26;b[c+a]=15299;break;case 40865:a=10;b[c+a]=B(d,0,48833);break;case 8579:a=30;b[c+a]=B(d,9,48146);break;case 45218:a=28;b[c+a]=51115;break;case 8570:a=22;h=b[c+8];b[c+a]=h===b[c+21];break;case 33783:a=27;b[c+a]=15371;break;case 18478:a=13;h=b[c+7];b[c+a]=h===b[c+12];break;case 63914:a=2;b[c+a]=B(d,13,0);break;case 51668:p=22;l=416;b[c+p]&&(e.j=l);break;
case 11733:a=28;b[c+a]=37192;break;case 28212:a=27;b[c+a]=26727;break;case 55080:a=I(d);h=b[c+I(d)];b[c+a]=h<<b[c+I(d)];break;case 34997:a=25;b[c+a]=B(d,22,17109);break;case 40017:a=I(d);b[c+a]=typeof b[c+I(d)];break;case 42789:a=1;b[c+a]=b[c+4];break;case 42178:a=28;b[c+a]=11279;break;case 33888:a=I(d);b[c+a]=I(d);break;case 9576:a=31;h=b[c+5];b[c+a]=h>b[c+30];break;case 9695:d.C[B(d)]=b[c+I(d)];break;case 52523:a=26;b[c+a]=48462;break;case 57979:throw b[c+I(d)];case 5207:a=I(d);var qa=B(d);N=Object.prototype.hasOwnProperty.call(d.C,
qa)?d.C[qa]:void 0;b[c+a]=typeof N;break;case 48152:a=2;b[c+a]=b[c+4];break;case 35255:a=30;h=b[c+1];b[c+a]=h<=b[c+29];break;case 29133:a=28;b[c+a]=48053;break;case 58091:a=3;b[c+a]=B(d,27,54427);break;case 8386:a=27;b[c+a]=29674;break;case 39710:a=26;b[c+a]=55240;break;case 29797:a=11;b[c+a]=B(d,14,19695);break;case 58346:a=2;b[c+a]=B(d,26,9252);break;case 38319:a=I(d);w=b[c+I(d)];z=b[c+I(d)];b[c+a]=w[z];break;case 23668:a=26;b[c+a]=63446;break;case 30824:a=27;b[c+a]=45446;break;case 20277:a=30;
b[c+a]=B(d,23,16334);break;case 53273:a=26;b[c+a]=34027;break;case 23724:a=27;b[c+a]=39434;break;case 23917:a=27;b[c+a]=43482;break;case 22738:p=21;l=118;b[c+p]&&(e.j=l);break;case 64284:a=27;b[c+a]=64964;break;case 64251:a=27;b[c+a]=52423;break;case 30908:a=21;h=b[c+7];b[c+a]=h===b[c+20];break;case 8120:a=28;b[c+a]=6573;break;case 15616:a=28;b[c+a]=40723;break;case 40501:k=b[c+30];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&
k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 43904:a=I(d);w=b[c+I(d)];z=b[c+I(d)];b[c+a]=delete w[z];break;case 60845:a=22;b[c+a]=B(d,7,13959);break;case 61174:a=26;b[c+a]=60787;break;case 25287:a=14;b[c+a]=B(d,3,52933);break;case 21764:a=27;b[c+a]=37980;break;case 22858:a=27;b[c+a]=54157;break;case 14347:a=I(d);h=b[c+I(d)];b[c+a]=h&b[c+I(d)];break;case 37980:a=I(d);h=b[c+I(d)];b[c+a]=h<b[c+I(d)];break;case 35397:a=I(d);b[c+a]=+b[c+I(d)];break;case 35514:p=25;l=152;b[c+p]&&(e.j=l);
break;case 55255:a=19;h=b[c+7];b[c+a]=h===b[c+18];break;case 39015:a=I(d);b[c+a]=-b[c+I(d)];break;case 38427:a=I(d);C=b[c+I(d)];D=I(d);if(D===1346325351)u=b[c+I(d)];else for(u=Array(D),g=0;g<D;g++)u[g]=b[c+I(d)];if(r=C&&n.get(C)){v=d.v;P(d,v,r.i.m);d.v=v+r.i.m;J=new f(r,d.C,a,v);if(r.i.L){E=r.i.B-1;for(g=0;g<E;g++)d.g[v+g]=g<u.length?u[g]:void 0;d.g[v+E]=u.slice(E)}else for(g=0;g<u.length&&g<r.i.m;g++)d.g[v+g]=u[g];r.i.B<r.i.m&&(d.g[v+r.i.B]=u);d.l.push(d.o);d.o=J}else b[c+a]=C.apply(null,u);break;
case 35553:a=28;b[c+a]=17042;break;case 37928:a=26;b[c+a]=18841;break;case 16154:a=0;b[c+a]=b[c+29];break;case 16094:a=24;b[c+a]=B(d,8,35519);break;case 33144:a=27;b[c+a]=59351;break;case 20740:k=b[c+I(d)];M(d,e);x=e.h+e.A.i.m;for(g=e.h;g<x;g++)d.g[g]=void 0;d.v=e.h;if(d.l.length===0)return k;e.u===null||typeof k==="object"&&k!==null||(k=e.u);t=d.l.pop();d.g[t.h+e.D]=k;d.o=t;break;case 41670:a=9;b[c+a]=B(d,15,58824);break;case 64390:a=I(d);b[c+a]=!b[c+I(d)];break;case 61626:a=27;b[c+a]=34012;break;
case 3843:a=1;b[c+a]=b[c+29];break;case 33412:e.j=b[c+26];break;default:throw Error("Unknown opcode: "+m+" at pc "+(e.j-1));case 17870:p=11,l=33,b[c+p]&&(e.j=l)}}catch(A){e=null;for(m=d.o;;){if(m.I.length>0){e=m;break}M(d,m);d.v=m.h;if(d.l.length===0)break;m=d.l.pop();d.o=m}if(!e)throw A;m=e.I.pop();d.l.length=m.S;y=e.h;m.R!==void 0?(d.g[y+m.R]=A,e.j=m.X):(d.g[y+m.V]=m.aa,d.g[y+m.Z]=A,e.j=m.W);d.v=y+e.A.i.m;d.o=e}}}var Q=globalThis;
typeof window!=="undefined"&&(Q.window=window,Q.document=typeof document!=="undefined"?document:void 0);typeof module!=="undefined"&&(Q.module=module,Q.exports=typeof exports!=="undefined"?exports:void 0);
for(var ua=ta,R=da("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"),Ka=
new Uint32Array(R.length/4),W=0;W<Ka.length;W++)Ka[W]=(R[W*4]|R[W*4+1]<<8|R[W*4+2]<<16|R[W*4+3]<<24)>>>0;ua(new ba(Ka,32,[34991,8448,24636,57399,29690,22298,59507,53619,50352,48147,53651,"MCs7KzsrJSs4KzQrPCs=","l+Gx4c7hluE=",void 0,54717,54029,58473,45002,4104,64531,7523,30638,21997,16334,"8BbmFvwW9hY=",5831,56283,52226],Q));
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
- [x] try..catch..finally
- [x] getter/setters
- [x] debugger;
- [x] template literals (**ES6**)
- [x] rest parameters (**ES6**)
- [x] spread operator (**ES6**)
- [x] object methods, computed property keys (**ES6**)
- [x] arrow functions (**ES6**)

### Missing

- [ ] with statement
- [ ] arguments.callee, argument parameter syncing   
- [ ] eval() referencing local variables

### Hardening

- [x] opcode randomization per build
- [x] property name concealment of vm internals
- - Google Closure Compiler aggressively renames our class props
- [x] shuffled handler order
- [ ] dead handlers
- [ ] dead bytecode insertion
- [x] macro opcodes (Combine multiple opcodes into a "macro opcode")
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

#### `controlFlowFlattening` (true/false)

Flattens the control flow of your program into a convoluted state machine.

```js
// Input Code
var message;
if (true) {
  message = "Hello World";
}

// Before
// fn_0_0:
  r0 = undefined
  r1 = true
  if (!r1) goto: if_else_1
  r1 = "Hello World"
  r0 = r1
// if_else_1:
  r1 = undefined
  return r1

// After
// fn_0_0:
  r1 = 969
  r2 = r1
// while_top_5:
  r3 = 4439
  r4 = r2 !== r3
  if (!r4) goto: while_exit_6
  r5 = 969
  r6 = r2 === r5
  if (!r6) goto: if_else_7
  goto: cff_block_2
// if_else_7:
  r7 = 1317
  r8 = r2 === r7
  if (!r8) goto: if_else_8
  goto: cff_block_3
// if_else_8:
  r9 = 58894
  r10 = r2 === r9
  if (!r10) goto: if_else_9
  goto: if_else_1
// if_else_9:
  goto: while_top_5
// while_exit_6:
// cff_block_3:
  r11 = "Hello World"
  r0 = r11
  r2 = 58894
  goto: while_top_5
// if_else_1:
  r11 = undefined
  return r11
// cff_block_2:
  r0 = undefined
  r11 = true
  if (r11) goto: cff_skip_10
  r2 = 58894
  goto: while_top_5
// cff_skip_10:
  r2 = 1317
  goto: while_top_5
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

#### `stringConcealing` (true/false)

Encodes strings to conceal plain-text values.

```js
// Input Code
console.log("Hello world!");

// Before
// fn_0_0:
  r0 = console
  r1 = "log"
  r2 = r0[r1]
  r1 = "Hello world!"
  r3 = r2.call(r0, r1)
  r0 = undefined
  return r0                       

// After
// fn_0_0:
  r0 = MakeClosure(fn_2_2, params=1, regs=3)
  r1 = console
  r2 = "bG9n"
  r2 = r0(r2)
  r3 = r1[r2]
  r2 = "SGVsbG8gd29ybGQh"
  r2 = r0(r2)
  r4 = r3.call(r1, r2)
  r1 = undefined
  return r1
// fn_2_2:
  r1 = atob
  r2 = r1(r0)
  return r2
  r1 = undefined
  return r1
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
case OP.LOAD_GLOBAL:
  var dst = this._operand();
  frame.regs[dst] = this.globals[this.constants[this._operand()]];
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

#### `classObfuscation` (true/false)

Obfuscates the VM runtime classes by shuffling the order of declarations and methods.

#### `minify` (true/false)

Minifies the final code with Google Closure Compiler. Renames the VM class properties.

#### `verbose` (true/false)

Prints obfuscator info useful for debugging purposes.

### Methods

#### `JSConfuserVM.obfuscate(sourceCode, options)`

Returns a `Promise<ObfuscationResult>` which contains a `code` property with the obfuscated code.

#### `JSConfuserVM.disassemble(sourceCode)`

Returns a partial JS representation based on the debug bytecode comment, for debugging and unobfuscated outputs.

Returns a `Promise<string>` which resolves to the disassembled code.

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

- Don't rely on "function.length"
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

- 202 tests, 91.18% coverage
- [Test262 (es5-tests)](https://github.com/tc39/test262/tree/es5-tests) percentage: 85.58%%

### Made with AI

This project has been created with the help of AI. Expect issues.

### License

MIT License