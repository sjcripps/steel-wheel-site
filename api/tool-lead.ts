import type { VercelRequest, VercelResponse } from '@vercel/node';
import commodityFlow from './_commodity-flow-lead';
import fleetCalculator from './_fleet-calculator-lead';
import storageLocator from './_storage-locator-lead';
import sublease from './_sublease-lead';

// Multiplexer for the four newest tool lead-capture endpoints. Each used to be
// its own Serverless Function, but the Hobby plan caps a deployment at 12
// functions and these four pushed it to 15 — so every deploy failed at
// patchBuild with exceeded_serverless_functions_per_deployment.
//
// The original handlers are unchanged; they were renamed with a leading
// underscore so Vercel no longer treats them as standalone functions, and this
// dispatcher imports + forwards to them. vercel.json rewrites map the public
// URLs (/api/<tool>-lead) to /api/tool-lead?tool=<tool>, so no frontend changed.

type Handler = (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>;

const ROUTES: Record<string, Handler> = {
  'commodity-flow': commodityFlow,
  'fleet-calculator': fleetCalculator,
  'storage-locator': storageLocator,
  'sublease': sublease,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const tool = String(req.query.tool ?? '').trim();
  const fn = ROUTES[tool];
  if (!fn) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(404).json({ ok: false, error: 'Unknown tool' });
  }
  return fn(req, res);
}
