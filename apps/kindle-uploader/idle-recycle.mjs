export function canRecycleIdleUploader(state) {
  return Boolean(
    state.recycleEligible &&
    !state.shuttingDown &&
    !state.browserRunning &&
    !state.browserStarting &&
    !state.browserClosing &&
    !state.displayRuntimeRunning &&
    !state.vncRunning &&
    !state.queueRunning &&
    !state.hasPendingQueueJob &&
    state.activeVncConnections === 0 &&
    state.uploadTicketCount === 0 &&
    state.connectTokenCount === 0
  );
}
