import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type OhApi } from '../shared/ipc';

const invoke =
  <K extends keyof OhApi>(name: K) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(name, ...args);

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: OhApi = {
  init: invoke('init'),
  refreshModels: invoke('refreshModels'),
  pullModel: invoke('pullModel'),
  saveConfig: invoke('saveConfig'),
  pickFolder: invoke('pickFolder'),
  createSession: invoke('createSession'),
  openSession: invoke('openSession'),
  deleteSession: invoke('deleteSession'),
  listSessions: invoke('listSessions'),
  send: invoke('send'),
  abort: invoke('abort'),
  updateSession: invoke('updateSession'),
  respondApproval: invoke('respondApproval'),
  compact: invoke('compact'),
  upsertDaemon: invoke('upsertDaemon'),
  removeDaemon: invoke('removeDaemon'),
  runDaemon: invoke('runDaemon'),
  stopDaemon: invoke('stopDaemon'),
  getDaemonMemory: invoke('getDaemonMemory'),
  setDaemonMemory: invoke('setDaemonMemory'),
  resolveInbox: invoke('resolveInbox'),
  markInboxRead: invoke('markInboxRead'),
  onAgentEvent: (cb) => listen(CHANNELS.agentEvent, cb),
  onDaemonEvent: (cb) => listen(CHANNELS.daemonEvent, cb),
  onPullProgress: (cb) => listen(CHANNELS.pullProgress, cb),
} as OhApi;

contextBridge.exposeInMainWorld('oh', api);
