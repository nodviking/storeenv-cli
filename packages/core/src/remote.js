// Normalises a Git remote URL into a stable project identity.
//   git@github.com:Acme/CakeShop.git      -> github.com/acme/cakeshop
//   https://user:pw@github.com/acme/cakeshop -> github.com/acme/cakeshop

export const normalizeRemote = (input) => {
  let text = String(input || "").trim();
  if (!text) return null;

  let host;
  let path;

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    host = scp[1];
    path = scp[2];
  } else {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    host = url.hostname;
    path = url.pathname;
  }

  const segments = path
    .replace(/\.git\/?$/i, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.length < 2) return null;

  host = host.toLowerCase().replace(/^www\./, "");
  const owner = segments[0];
  const name = segments[segments.length - 1];

  return {
    host,
    owner,
    name,
    slug: `${owner}/${name}`,
    remote: `${host}/${segments.join("/")}`,
    isGitHub: host === "github.com",
  };
};

export const parseProjectSlug = (text) => {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(text || "").trim());
  return match ? { owner: match[1].toLowerCase(), name: match[2].toLowerCase() } : null;
};
