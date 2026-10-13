
const noop = () => {}
const chain = { get: noop, post: noop, put: noop, delete: noop, use: noop }
const electron = { app: { getPath: () => '/tmp' } }
const browserManager = {
  getRunningWindowIds: () => [], replayRpaScript: async () => 0,
  startRpaRecording: noop, stopRpaRecording: () => [], isRpaRecording: () => false, rpaRecordCount: () => 0
}
