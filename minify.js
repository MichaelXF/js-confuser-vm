import ClosureCompiler from "google-closure-compiler";

const compiler = new ClosureCompiler({
  js: "output.js",
  js_output_file: "output.min.js",
  compilation_level: "ADVANCED",

  warning_level: "QUIET",
  env: "CUSTOM", // removes all default externs
  externs: "minify_empty_externs.js", // pass a blank file to satisfy the flag
});

compiler.run((exitCode, stdOut, stdErr) => {
  if (stdErr) console.error(stdErr);
  if (exitCode !== 0) process.exit(exitCode);
  console.log("Done -> output.min.js");
});
