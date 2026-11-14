import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { dim, line, setResult, table } from "../services/output.js";

export const command = "projects";
export const describe = "List the projects you are a member of";
export const builder = (yargs) => yargs.option("namespace", { type: "string", describe: "Only this namespace" });

export const handler = async (argv) => {
  ensureAuthenticated();
  let { projects } = await api.projects();
  if (argv.namespace) projects = projects.filter((project) => (project.namespace || project.owner) === String(argv.namespace).toLowerCase());
  if (!projects.length) line(dim("No projects yet. Create one: storeenv init"));
  else table(["PROJECT", "ID", "ROLE", "KIND"], projects.map((project) => [project.fullName, project.id, project.role || "", project.kind || "app"]));
  setResult({ projects: projects.map((project) => ({ id: project.id, fullName: project.fullName, namespace: project.namespace, role: project.role, kind: project.kind })) });
};
