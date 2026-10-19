// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.

/** Serialized fetch messages shared by the Electron renderer and main process. */
export interface ApiFetchRequest {
  id: string;
  url: string;
  method: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

export type ApiFetchResult = {
  success: true;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
} | {
  success: false;
  error: string;
  aborted: boolean;
};

export interface ApiFetchBridge {
  request: (request: ApiFetchRequest) => Promise<ApiFetchResult>;
  abort: (id: string) => void;
}
