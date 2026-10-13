import type { OhApi } from '../../shared/ipc';

declare global {
  interface Window {
    oh: OhApi;
  }
}

export {};
