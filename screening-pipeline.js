import { withReadDeadline } from "./read-deadline.js";

/** Read cancellation must never release or race an in-progress financial execution. */
export async function runScreeningPipeline({ read, execute, timeoutMs = 30_000, onStage = () => {} }) {
  onStage("reading");
  const result = await withReadDeadline(read, { timeoutMs, label: "Screening read phase" });
  if (!result?.selected) return result;
  onStage("executing");
  return { ...result, execution: await execute(result) };
}

export function queueScreeningAfterManagement(callback) {
  setImmediate(callback);
}
