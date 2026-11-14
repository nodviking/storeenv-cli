import readline from "node:readline";
import chalk from "chalk";
import { StoreEnvError } from "@storeenv/core";

const state = { yes: false };

export const configurePrompt = ({ yes }) => {
  state.yes = Boolean(yes);
};

// No prompts in CI, in pipes, or with --yes.
export const isInteractive = () => !state.yes && !process.env.CI && Boolean(process.stdin.isTTY && process.stdout.isTTY);
export const assumeYes = () => state.yes || Boolean(process.env.CI);
// Only a typed --yes, never CI alone, can create things on the server.
export const explicitYes = () => state.yes;

export const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

export const confirm = async (question, fallback = true) => {
  if (assumeYes()) return true;
  if (!isInteractive()) return fallback;
  const answer = (await ask(`  ${question} ${fallback ? "(Y/n)" : "(y/N)"} `)).toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
};

// A list the user moves through with the arrow keys (or j and k) and
// confirms with Enter. Each option's key still works as a shortcut.
// options: [{ key: "k", label: "Keep my local file", hint: "..." }]
export const choose = async (question, options, fallback) => {
  if (!isInteractive()) return fallback;
  const { stdin, stdout } = process;
  let index = Math.max(0, options.findIndex((option) => option.key === fallback));
  const lines = options.length;

  const draw = (first) => {
    if (!first) stdout.write(`\x1b[${lines}A`);
    options.forEach((option, i) => {
      const active = i === index;
      const label = active ? chalk.cyan(`> ${option.label}`) : `  ${option.label}`;
      stdout.write(`\x1b[2K    ${label}${option.hint ? `  ${chalk.dim(option.hint)}` : ""}\n`);
    });
  };

  if (question) stdout.write(`  ${question}\n`);
  stdout.write(`  ${chalk.dim("Use arrow keys, then Enter")}\n`);
  stdout.write("\x1b[?25l");
  draw(true);

  readline.emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve) => {
    const finish = (value) => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\x1b[?25h");
      resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        stdout.write("\n");
        process.exit(130);
      }
      if (key.name === "up" || key.name === "k" && !options.some((option) => option.key === "k")) {
        index = (index - 1 + lines) % lines;
        draw(false);
      } else if (key.name === "down" || key.name === "j" && !options.some((option) => option.key === "j")) {
        index = (index + 1) % lines;
        draw(false);
      } else if (key.name === "return" || key.name === "enter") {
        finish(options[index].key);
      } else if (key.name === "escape") {
        finish(fallback);
      } else {
        const picked = options.findIndex((option) => option.key === String(text || "").toLowerCase());
        if (picked >= 0) {
          index = picked;
          draw(false);
          finish(options[picked].key);
        }
      }
    };
    stdin.on("keypress", onKey);
  });
};

export const input = async (question, fallback = "") => {
  if (!isInteractive()) return fallback;
  return (await ask(`  ${question} `)) || fallback;
};

// Reads a line without echoing it. Used for the recovery phrase.
export const hidden = async (question) => {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(`  ${question}\n  `);
    rl._writeToOutput = (text) => {
      if (text.includes("\n")) process.stdout.write("\n");
      else process.stdout.write("*");
    };
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

export const requireTyped = async (question, expected) => {
  if (assumeYes()) return;
  if (!isInteractive()) throw new StoreEnvError("SE_INVALID", "This action needs confirmation.", { hint: "Run it again with --yes" });
  const answer = await ask(`  ${question} `);
  if (answer !== expected) throw new StoreEnvError("SE_INVALID", "Confirmation did not match. Nothing was changed.");
};
