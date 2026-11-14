// Thin layer over @storeenv/core: turns values into upload ready entries and
// back. Every function here runs on the developer's machine.

import {
  assertEntryLocation, assertSafeEnvNames, buildAad, canReadSecret, decryptSecret, encryptSecret, generateEsk, newId, unwrapEsk, wrapEsk,
} from "@storeenv/core";

// Members who should receive a key share for one secret.
export const readersFor = (readers, target) =>
  readers.filter((reader) => reader.publicKey && canReadSecret(reader, target));

export const waitingFor = (readers, target) =>
  readers.filter((reader) => !reader.publicKey && canReadSecret(reader, target));

// New ESK, AES-256-GCM, one wrapped ESK per authorised reader.
export const encryptEntry = ({ projectId, environment, service, name, value, rev, readers, isProtected, rekeyOf }) => {
  const esk = generateEsk();
  const aad = buildAad({ projectId, environment, service, name, rev });
  const sealed = encryptSecret({ esk, value, aad });
  const target = { env: environment, service, key: name, protected: isProtected };
  const keyShares = readersFor(readers, target).map((reader) => ({ userId: reader.userId, wrappedEsk: wrapEsk(esk, reader.publicKey, aad) }));
  esk.fill(0);
  return { id: newId("ent"), name, rev, ...sealed, keyShares, ...(rekeyOf ? { rekeyOf } : {}) };
};

export const decryptEntry = (entry, privateKey) => {
  const esk = unwrapEsk(entry.wrappedEsk, privateKey, entry.aad);
  try {
    return decryptSecret({ esk, ciphertext: entry.ciphertext, iv: entry.iv, authTag: entry.authTag, aad: entry.aad });
  } finally {
    esk.fill(0);
  }
};

// The only way commands get a value: the name must be one the API accepts
// and the entry must carry the AAD of the place this client asked for
// (where: { projectId, environment, service }). Both are checked before
// anything is decrypted.
export const decryptAt = (entry, privateKey, where) => {
  assertSafeEnvNames([entry.name]);
  assertEntryLocation(entry, where);
  return decryptEntry(entry, privateKey);
};

export const rewrapEsk = (wrappedEsk, privateKey, aad, recipientPublicKey) => {
  const esk = unwrapEsk(wrappedEsk, privateKey, aad);
  try {
    return wrapEsk(esk, recipientPublicKey, aad);
  } finally {
    esk.fill(0);
  }
};

export const canDecrypt = (entry) => Boolean(entry.shared && entry.wrappedEsk);
