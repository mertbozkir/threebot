// noVNC ships JavaScript only; the Desktop view types the parts it uses.
declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
  }
}
