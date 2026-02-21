import ClosureCompiler from "google-closure-compiler";

export function minify(sourceCode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const compiler = new ClosureCompiler({
      compilation_level: "ADVANCED",
      warning_level: "QUIET",
    });

    const compilerProcess = compiler.run((exitCode: number, stdOut: string, stdErr: string) => {
      if (exitCode !== 0) {
        reject(new Error(stdErr || `Closure Compiler exited with code ${exitCode}`));
      } else {
        resolve(stdOut);
      }
    });

    compilerProcess.stdin.write(sourceCode);
    compilerProcess.stdin.end();
  });
}
