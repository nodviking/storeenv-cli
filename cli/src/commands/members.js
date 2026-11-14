import { timeUntil } from "@storeenv/core";
import { api } from "../services/api.js";
import { dim, line, setResult, table } from "../services/output.js";
import { openProject } from "../services/session.js";

export const command = "members";
export const describe = "List members, roles and pending key shares";

export const handler = async (argv) => {
  const { project } = await openProject(argv);
  const { members, invites } = await api.members(project.id);
  table(
    ["MEMBER", "ROLE", "PROD", "SCOPE", "STATUS"],
    members.map((member) => [
      `@${member.login}`,
      member.role,
      member.prodAccess ? "yes" : "no",
      member.scope,
      member.expiresAt ? `${member.status}, expires in ${timeUntil(member.expiresAt)}` : member.status,
    ]),
  );
  if (invites.length) {
    line();
    line(dim("Invited, waiting to accept:"));
    for (const invite of invites) line(dim(`  ${invite.invitee}   ${invite.role}   ${invite.scope}`));
  }
  setResult({ project: project.fullName, members: members.map(({ login, role, prodAccess, scope, status, expiresAt }) => ({ login, role, prodAccess, scope, status, expiresAt })), invites });
};
