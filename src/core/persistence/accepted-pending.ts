/**
 * #5600/#5601: an accepted write that has not committed yet is progress, not
 * a failure. It keeps its request identity and publishes later; the caller
 * records it and moves on, and a rerun resumes the same request. Shared by
 * connector sync, managed import and managed atom publication.
 */
import { OperationError } from '../ops/contract.ts';
import { isTerminalWriteState, type WriteReceipt } from './types.ts';

export function acceptedPendingReceipt(error: unknown): WriteReceipt | null {
  if (!(error instanceof OperationError) || error.code !== 'write_pending' || !error.writeRequest) return null;
  return isTerminalWriteState(error.writeRequest.state) ? null : error.writeRequest;
}

/**
 * #6006: a write admission that exhausted its retry budget under row-lock
 * contention never produced a request row. A caller whose request_id is
 * deterministic can resubmit the same intent on a rerun, so the miss defers
 * like a pending receipt rather than failing the whole operation.
 */
export function isWriteAdmissionContention(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'storage_error' && error.detail === 'database_contention';
}
