// Node globals the engine's modules touch, for the browser bundle (injected by esbuild).
export const process = { env: {} };
const enc = new TextEncoder();
export const Buffer = {
  byteLength: (s) => enc.encode(String(s)).length,
  from: (s) => enc.encode(String(s)),
};
