/**
 * WebSocket client with auto-reconnect
 */

import WebSocket from 'ws';

export class WSClient {
  constructor(url, handlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.ws = null;
    this.reconnectDelay = 3000;
    this.shouldReconnect = true;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      if (this.handlers.onOpen) this.handlers.onOpen();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (this.handlers.onMessage) this.handlers.onMessage(msg);
      } catch (err) {
        console.error('[WS] Failed to parse message:', err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || '';
      if (this.handlers.onClose) this.handlers.onClose(code, reasonStr);

      // Auto-reconnect (skip for auth/notfound errors)
      if (this.shouldReconnect && code !== 4001 && code !== 4004) {
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    });

    this.ws.on('error', (err) => {
      if (this.handlers.onError) this.handlers.onError(err);
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  close() {
    this.shouldReconnect = false;
    if (this.ws) this.ws.close();
  }
}
