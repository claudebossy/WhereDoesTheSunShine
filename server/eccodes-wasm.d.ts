declare module '@meri-imperiumi/eccodes-wasm' {
  export interface CodesHandle {
    getLong(key: string): number;
    getDouble(key: string): number;
    getString(key: string): string;
    getSize(key: string): number;
    getDoubleArray(key: string): number[];
  }
  export interface Eccodes {
    getVersion(): number;
    writeFile(path: string, data: Uint8Array): void;
    forEachMessage(path: string, callback: (handle: CodesHandle) => void): void;
  }
  const api: { createEccodes(): Promise<Eccodes> };
  export default api;
}
