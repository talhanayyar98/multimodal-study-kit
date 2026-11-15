export declare const MODEL: { url: string; sha256: string; bytes: number };
export declare const CACHE: string;
export declare function sha256(buf: Uint8Array): string;
export declare function ensureModel(): Promise<string>;
