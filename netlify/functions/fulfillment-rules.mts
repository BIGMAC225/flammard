// Netlify scheduled function (v2): runs the fulfillment rules and alerts once
// a day. 13:00 UTC is about 7–8 AM Central (8:00 on CDT, 7:00 on CST); the
// after-import trigger lives in the import libs (src/lib/fulfillment-poll.ts
// and src/lib/fulfillment-csv-import.ts), which call the same runner right
// after their own 'ok' update, guarded so a rules failure never fails the
// import. The walk itself is src/lib/fulfillment-rules.ts.

import { runFulfillmentRules } from '../../src/lib/fulfillment-rules';

// Daily, UTC time
export const config = { schedule: '0 13 * * *' };

export default async (_req: Request): Promise<void> => {
  try {
    const r = await runFulfillmentRules({ mode: 'daily' });
    console.log(
      `[fulfillment-rules] daily: opened ${r.opened}, resolved ${r.resolved}, releveled ${r.releveled}, unsnoozed ${r.unsnoozed}, ${r.digests.length} digests, posted ${r.posted}`
    );
  } catch (err) {
    // Never throw: a failed schedule is visible only in the function log
    console.log(`[fulfillment-rules] failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
};
