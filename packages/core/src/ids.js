import { randomBytes, toHex } from "./bytes.js";

// Client generated ids make every write idempotent: retrying a request with
// the same id returns the object that already exists.

export const newId = (prefix) => `${prefix}_${toHex(randomBytes(12))}`;

// Version ids look like Git hashes: 40 hex characters, shown as the first 7.
export const newVersionId = () => toHex(randomBytes(20));

export const shortId = (versionId) => (versionId ? versionId.slice(0, 7) : "");

export const isVersionRef = (text) => /^[0-9a-f]{4,40}$/.test(text || "");

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// Short human codes such as 7KQ2-MX. Ambiguous characters are left out.
export const newApprovalCode = () => {
  const bytes = randomBytes(6);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

export const normalizeCode = (code) => {
  const clean = String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return clean.length === 6 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
};
