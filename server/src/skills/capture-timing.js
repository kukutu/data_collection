export const CAPTURE_LEAD_MS = 1000;

/**
 * Start both capture components through TaskManager, then leave a fixed
 * one-second lead before the business action is sent to the device.
 */
export async function startCaptureBeforeAction(
  startCapture,
  sleep,
  leadMs = CAPTURE_LEAD_MS,
) {
  if (typeof startCapture !== 'function') return false;
  await startCapture();
  const waitMs = Math.max(0, Number(leadMs) || 0);
  if (waitMs > 0 && typeof sleep === 'function') await sleep(waitMs);
  return true;
}
