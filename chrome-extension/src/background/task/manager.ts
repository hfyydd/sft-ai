import { runController } from './run-controller';

/**
 * Stable task-runtime facade for the background layer.
 * Keeping this API separate from RunController prevents message handlers
 * from depending on its internal implementation.
 */
export const taskManager = {
  configure: runController.configure.bind(runController),
  initialize: runController.initialize.bind(runController),
  createAndStart: runController.createAndStart.bind(runController),
  continueWithFollowUp: runController.continueWithFollowUp.bind(runController),
  startReplay: runController.startReplay.bind(runController),
  pause: runController.pause.bind(runController),
  resume: runController.resume.bind(runController),
  cancel: runController.cancel.bind(runController),
  recover: runController.recover.bind(runController),
  snapshot: runController.snapshot.bind(runController),
  subscribe: runController.subscribe.bind(runController),
  handleTabClosed: runController.handleTabClosed.bind(runController),
  handleDebuggerDetached: runController.handleDebuggerDetached.bind(runController),
  getExecutor: runController.getExecutor.bind(runController),
  getRunId: runController.getRunId.bind(runController),
  clearIfTerminal: runController.clearIfTerminal.bind(runController),
};

export { runController };
