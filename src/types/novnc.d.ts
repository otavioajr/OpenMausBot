// noVNC ships no type declarations. Declare only the surface we use, so a
// typo in an option or event name is still caught at build time.
declare module "@novnc/novnc" {
  interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: Element, url: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    clipViewport: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendKey(keysym: number, code?: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
  }
}
