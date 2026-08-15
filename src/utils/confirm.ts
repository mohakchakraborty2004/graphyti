import * as readline from "readline";

/**
 * Ask a yes/no question on stdin and resolve true only on an explicit "y".
 *
 * This is the same gate the blast-radius confirmation uses in
 * generate/preWriteCheck.ts (which keeps its own local copy — that file is not
 * touched in this phase). Anything that mutates the user's machine outside of
 * writing generated files should go through one of the two.
 */
export function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}
