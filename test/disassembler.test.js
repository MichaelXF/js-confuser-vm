import { disassembleCommentBlock } from "../src/disassembler";

// Bytecode comment block matching the compiler's debug output for: console.log("Hello world!")
const HELLO_WORLD_BYTECODE = `
// fn_0_0:
// [47, 0, 45, 1, 3, 0, 0], MAKE_CLOSURE  reg[0] PC=fn_2_2 (params=1 regs=3 upvalues=0)
// [2, 1, 0, 0],        LOAD_GLOBAL  reg[1] = console                     1:0-1:7
// [0, 2, 1, 0],        LOAD_CONST  reg[2] = "bG9n"                       1:0-1:27
// [42, 2, 0, 1, 2],    CALL  reg[2] = reg[0](reg[2])
// [8, 3, 1, 2],        GET_PROP  reg[3] = reg[1][reg[2]]                 1:0-1:27
// [0, 2, 2, 0],        LOAD_CONST  reg[2] = "SGVsbG8gd29ybGQh"           1:12-1:26
// [42, 2, 0, 1, 2],    CALL  reg[2] = reg[0](reg[2])
// [43, 4, 1, 3, 1, 2], CALL_METHOD  reg[4] = reg[3](recv=reg[1], 1 args) 1:0-1:27
// [0, 1, 3, 0],        LOAD_CONST  reg[1] = undefined
// [45, 1],             RETURN  reg[1]
// fn_2_2:
// [2, 1, 4, 0],        LOAD_GLOBAL  reg[1] = atob                        3:13-3:17
// [42, 2, 1, 1, 0],    CALL  reg[2] = reg[1](reg[0])                     3:13-3:26
// [45, 2],             RETURN  reg[2]                                    3:6-3:27
// [0, 1, 3, 0],        LOAD_CONST  reg[1] = undefined                    2:4-4:5
// [45, 1],             RETURN  reg[1]                                    2:4-4:5
`;

// Source locations

test("Variant #1: Source locations are appended to instructions that have them", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  expect(output).toContain("// 1:0-1:7");
});

test("Variant #2: Instructions without source location have no trailing loc comment", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  var lines = output.split("\n");

  // CALL instructions in fn_0_0 have no source location in the bytecode above
  var callLines = lines.filter((l) => l.includes("r0(r2)"));
  expect(callLines.length).toBeGreaterThan(0);
  for (var l of callLines) {
    expect(l).not.toMatch(/\/\/\s*\d+:\d+-\d+:\d+/);
  }
});

// Function metadata comments

test("Variant #3: Function labels referenced by MAKE_CLOSURE show parameter registers", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  expect(output).toContain("// fn_2_2(r0):");
});

test("Variant #4: Root function label not referenced by MAKE_CLOSURE has no metadata comment", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  // fn_0_0 has no MAKE_CLOSURE pointing at it
  var lines = output.split("\n");
  var rootLabel = lines.find((l) => l.startsWith("// fn_0_0:"));
  expect(rootLabel).toBeDefined();
  expect(rootLabel).toBe("// fn_0_0:");
});

// Instruction disassembly

test("Variant #5: LOAD_GLOBAL resolves constant value from annotation", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  expect(output).toContain("r1 = console");
  expect(output).toContain("r1 = atob");
});

test("Variant #6: CALL_METHOD is rendered with recv and args", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  expect(output).toContain("r4 = r3.call(r1, r2)");
});

test("Variant #7: MAKE_CLOSURE uses the label name from annotation", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  expect(output).toContain("r0 = MakeClosure(fn_2_2, params=1, regs=3)");
});

test("Variant #8: Multiple functions are each emitted as separate label sections", () => {
  var output = disassembleCommentBlock(HELLO_WORLD_BYTECODE);
  var lines = output.split("\n");
  var labelLines = lines.filter((l) => /^\/\/ \w+[\w()*, ]*:/.test(l));
  expect(labelLines).toHaveLength(2);
  expect(labelLines[0]).toMatch(/fn_0_0/);
  expect(labelLines[1]).toMatch(/fn_2_2/);
});
