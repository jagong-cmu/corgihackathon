/** Zero-dependency probe: distinguishes "functions can't run at all" from
 * "a specific import crashed". Safe to keep; useful as an uptime check. */
interface FnRes {
  status(code: number): FnRes;
  json(body: unknown): void;
}

export default function handler(_req: unknown, res: FnRes): void {
  res.status(200).json({ ok: true });
}
