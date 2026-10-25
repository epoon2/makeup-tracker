/*
  The calculator's server: one Netlify Function answering /api/*.
  Everything it does is in netlify/lib/core.mjs; this file only connects it to
  Netlify Blobs and the site's environment variables.

  Environment variables (Netlify: Site configuration -> Environment variables):
    SETUP_CODE      needed once, to make the first (admin) account. 8+ characters.
                    Setup refuses once any account exists.
    SESSION_SECRET  optional. 32+ characters to sign sign-in cookies with; without it a
                    random secret is made and kept in Blobs.

  The live site and every other deploy (deploy previews, branch deploys, `netlify dev`)
  keep separate stores: a preview has its own accounts and its own copy of the data,
  and cannot read or change the live site's.
*/

import { getStore } from "@netlify/blobs";
import { createApi } from "../lib/core.mjs";

// Survives between requests on a warm function: the signing secret, the backup day.
const cache = {};

const readEnv = (name) => {
  const fromNetlify = globalThis.Netlify && globalThis.Netlify.env ? globalThis.Netlify.env.get(name) : undefined;
  return fromNetlify !== undefined ? fromNetlify : process.env[name];
};

export default async (req, context) => {
  const deployContext = context && context.deploy ? context.deploy.context : undefined;
  const live = !deployContext || deployContext === "production";
  const prefix = live ? "" : "preview-";
  const handle = createApi({
    // Strong consistency: a read straight after a write sees it, which the answers'
    // read-change-write cycle depends on.
    authStore: getStore({ name: prefix + "makeup-auth", consistency: "strong" }),
    dataStore: getStore({ name: prefix + "makeup-data", consistency: "strong" }),
    env: { SETUP_CODE: readEnv("SETUP_CODE"), SESSION_SECRET: readEnv("SESSION_SECRET") },
    cache,
    warnMissingEtag: deployContext === "production",
  });
  return handle(req, { ip: context && context.ip });
};

export const config = { path: "/api/*" };
