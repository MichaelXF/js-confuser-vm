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
