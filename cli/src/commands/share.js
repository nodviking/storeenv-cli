import { command as cmd, dim, line, setResult, success, warn } from "../services/output.js";
import { openProject } from "../services/session.js";
import { sharePending } from "../services/sharing.js";

export const command = "share";
export const describe = "Wrap keys for members who are waiting for a key share";
export const builder = (yargs) => yargs
    .option("skip-unverified", { type: "boolean", default: false, describe: "Encrypt only for readers whose keys are verified; the rest wait for a key share" });

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  const result = await sharePending(context.project.id, context.identity, { mode: argv.skipUnverified ? "skip" : "ask" });
  if (!result.people.length && !result.waiting.length) {
    line("Nobody is waiting for keys.");
  }
  for (const person of result.people) {
    success(`Wrapped ${person.secrets} ${person.secrets === 1 ? "key" : "keys"} for @${person.login}  ${dim(person.fingerprint)}`);
    if (person.remaining) warn(`@${person.login} still needs ${person.remaining} more that you can't read.`);
    else line(dim(`  @${person.login} can now run "${cmd("storeenv pull")}".`));
  }
  for (const person of result.waiting) line(dim(`@${person.login} ${person.reason}.`));
  setResult({ project: context.project.fullName, shared: result.shared, people: result.people, waiting: result.waiting });
};
