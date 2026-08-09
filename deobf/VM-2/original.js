// original.js was provided AFTER solution was reached!

if (true) {
  var div = document.createElement("div");
  div.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(div);
  var width = div.offsetWidth; // 100px + 20px*2 = 140px

  // Compute anti-bot key
  var ts = Date.now();
  var salt = Math.floor(Math.random() * 1000000);
  var modulo1 = (ts - 10000 + salt * 5) % 97;
  var modulo2 = (ts + salt + width) % 89;
  var modulo3 = (salt + 1500) % 83;
  var antibotKey =
    ts + "|" + salt + "|" + modulo1 + "|" + modulo2 + "|" + modulo3;

  function xorEncode(str, key) {
    let k = key;
    let out = "";
    for (let i = 0; i < str.length; i++) {
      k = (k + 0x9e3779b9) | 0;
      const ks = (k ^ (k >>> 13)) & 0xffff;
      out += String.fromCharCode(str.charCodeAt(i) ^ ks);
    }
    return out;
  }

  console.log(antibotKey, xorEncode(antibotKey, width + salt));
}
