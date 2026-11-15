#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { CLIENT_VERSION } from "./services/api.js";
import { setApiOverride } from "./services/config.js";
import { configureOutput, flushJson, printError } from "./services/output.js";
import { configurePrompt } from "./services/prompt.js";

import { COMMANDS, COMPLETION, GLOBAL_OPTIONS } from "./commands.js";

const commands = COMMANDS;

// Commands orchestrate, services implement. This wrapper gives every command
// the same error handling, exit codes and --json output.
const wrap = (module) => ({
  ...module,
  handler: async (argv) => {
    try {
      await module.handler(argv);
      flushJson();
    } catch (error) {
      printError(error);
      process.exitCode = error.exit || 1;
    }
  },
});

const cli = yargs(hideBin(process.argv))
  .scriptName("storeenv")
  .usage("$0 <command> [options]\n\nGit for environment secrets. Encrypted on your device before upload.")
  .options(Object.fromEntries(GLOBAL_OPTIONS))
  .middleware((argv) => {
    setApiOverride(argv.api);
    configureOutput({ json: argv.json, color: argv.color, verbose: argv.verbose });
    configurePrompt({ yes: argv.yes });
  })
  .parserConfiguration({ "populate--": true })
  .version(CLIENT_VERSION)
  .alias("h", "help")
  // bash and zsh: storeenv completion >> ~/.bashrc (or ~/.zshrc)
  .completion("completion", COMPLETION)
  .demandCommand(1, "Pass a command. Try: storeenv --help")
  .strictCommands()
  .recommendCommands()
  .epilogue("Docs: https://storeenv.app/docs")
  .fail((message, error, instance) => {
    if (error) {
      printError(error);
      process.exit(error.exit || 1);
    }
    process.stderr.write(`\n  ${message}\n\n`);
    instance.showHelp();
    process.exit(22);
  });

for (const module of commands) cli.command(wrap(module));

// No top level await, so the same source also bundles into the standalone binary.
cli.parseAsync().catch((error) => {
  printError(error);
  process.exit(error.exit || 1);
});
