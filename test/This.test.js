import { virtualize } from "../src";
import { evalCode } from "./test-utils";

// ── Constructor functions ─────────────────────────────────────────

test("Variant #1: Constructor sets properties on `this` via new", () => {
  const { code } = virtualize(`
    function Rectangle(width, height) {
      this.width = width;
      this.height = height;
      this.area = function() {
        return this.width * this.height;
      };
    }
    var r = new Rectangle(4, 5);
    window.TEST_OUTPUT = [r.width, r.height, r.area()];
  `);

  expect(evalCode(code)).toEqual([4, 5, 20]);
});

// ── Object literal method this ────────────────────────────────────

test("Variant #2: Object literal method receives object as `this`", () => {
  const { code } = virtualize(`
    var counter = {
      count: 0,
      increment: function() {
        this.count = this.count + 1;
        return this.count;
      }
    };
    counter.increment();
    counter.increment();
    window.TEST_OUTPUT = counter.increment();
  `);

  expect(evalCode(code)).toBe(3);
});

// ── Prototype methods ─────────────────────────────────────────────

test("Variant #3: Prototype methods receive instance as `this`", () => {
  const { code } = virtualize(`
    function Stack() {
      this.items = [];
    }
    Stack.prototype.push = function(item) {
      this.items.push(item);
    };
    Stack.prototype.pop = function() {
      return this.items.pop();
    };
    Stack.prototype.size = function() {
      return this.items.length;
    };

    var s = new Stack();
    s.push(10);
    s.push(20);
    s.push(30);
    window.TEST_OUTPUT = [s.size(), s.pop(), s.size()];
  `);

  expect(evalCode(code)).toEqual([3, 30, 2]);
});

// ── ES5 class extending ───────────────────────────────────────────

test("Variant #4: ES5 inheritance via Function.call forwards `this` to parent constructor", () => {
  const { code } = virtualize(`
    function Animal(name) {
      this.name = name;
      this.type = "animal";
    }

    function Dog(name, breed) {
      Animal.call(this, name);
      this.type = "dog";
      this.breed = breed;
    }
    Dog.prototype.describe = function() {
      return this.name + " is a " + this.breed;
    };

    var d = new Dog("Rex", "Labrador");
    window.TEST_OUTPUT = [d.name, d.type, d.breed, d.describe()];
  `);

  expect(evalCode(code)).toEqual(["Rex", "dog", "Labrador", "Rex is a Labrador"]);
});

// ── Exposed globals ───────────────────────────────────────────────

test("Variant #5: Function assigned to window called as method receives window as `this`", () => {
  const { code } = virtualize(`
    window.appName = "MyApp";
    function getAppName() {
      return this.appName;
    }
    window.getAppName = getAppName;
    window.TEST_OUTPUT = window.getAppName();
  `);

  expect(evalCode(code)).toBe("MyApp");
});

// ── Method chaining (return this) ────────────────────────────────

test("Variant #6: Returning `this` from prototype methods enables chaining", () => {
  const { code } = virtualize(`
    function Builder() {
      this.value = 0;
    }
    Builder.prototype.add = function(n) {
      this.value = this.value + n;
      return this;
    };
    Builder.prototype.multiply = function(n) {
      this.value = this.value * n;
      return this;
    };
    Builder.prototype.result = function() {
      return this.value;
    };

    var b = new Builder();
    window.TEST_OUTPUT = b.add(5).multiply(3).add(2).result();
  `);

  // (0 + 5) * 3 + 2 = 17
  expect(evalCode(code)).toBe(17);
});
